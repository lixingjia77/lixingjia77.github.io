# Hertz 源码学习笔记

> 本文由claude-4-sonnet总结个人走读Hertz源码的笔记生成

https://github.com/cloudwego/hertz/

## 前言

Hertz 是 CloudWeGo 开源的高性能 HTTP 框架，基于自研的高性能网络库 Netpoll 构建。本文将从源码角度深入分析 Hertz 的核心设计理念和实现细节，探讨其如何在保证易用性的同时实现高性能。

## 核心架构设计

### 整体架构

Hertz 采用分层设计，通过合理的组件分离实现了高度的可扩展性和可维护性。

@startuml Hertz核心组件架构
package "Hertz Framework" {
  
  class Hertz {
    *route.Engine
    signalWaiter func(err chan error) error
    --
    +Spin()
    +SetCustomSignalWaiter()
  }
  
  class Engine {
    -RouterGroup
    -trees MethodTrees
    -options *config.Options
    -transport network.Transporter
    -tracerCtl tracer.Controller
    -ctxPool sync.Pool
    --
    +NewEngine(opt *config.Options) *Engine
    +Run() error
    +Shutdown(ctx context.Context) error
    +addRoute(method, path string, handlers app.HandlersChain)
  }
  
  class Options {
    +Registry registry.Registry
    +RegistryInfo *registry.Info
    +Addr string
    +Network string
    +TransporterNewer func(*Options) network.Transporter
    --
    各种配置选项...
  }
  
  class RouterGroup {
    +Handlers app.HandlersChain
    +basePath string
    +engine *Engine
    --
    +Group(relativePath string, handlers ...app.HandlerFunc) *RouterGroup
    +GET/POST/PUT/DELETE(path string, handlers ...app.HandlerFunc)
    +Use(middleware ...app.HandlerFunc)
  }
  
  class MethodTrees {
    +get(method string) *router
  }
  
  class router {
    +method string
    +root *node
    --
    +addRoute(path string, h app.HandlersChain)
    +find(path string, params *param.Params) nodeValue
  }
  
  class node {
    +kind kind
    +prefix string
    +children []*node
    +paramChild *node
    +anyChild *node
    +handlers app.HandlersChain
    +pnames []string
    --
    radix tree 节点
  }
  
  interface Transporter {
    +ListenAndServe(onData OnData) error
    +Shutdown(ctx context.Context) error
    +Close() error
  }
  
  class NetpollTransporter {
    +el netpoll.EventLoop
    +ln net.Listener
    --
    基于cloudwego/netpoll实现
  }
  
  class StandardTransporter {
    +ln net.Listener
    --
    基于标准库net实现
  }
  
  interface Registry {
    +Register(info *Info) error
    +Deregister(info *Info) error
  }
  
  class RegistryInfo {
    +ServiceName string
    +Addr net.Addr
    +Weight int
    +Tags map[string]string
  }
}

' 关系定义
Hertz *-- Engine
Engine *-- RouterGroup
Engine *-- MethodTrees
Engine *-- Options
Engine *-- Transporter
MethodTrees *-- router
router *-- node
node *-- node : children
Options *-- Registry
Options *-- RegistryInfo
Registry ..> RegistryInfo
Transporter <|.. NetpollTransporter
Transporter <|.. StandardTransporter

@enduml
### 组件职责分析

**Hertz (服务端facade层)**
+ **职责**: 作为整个框架的外观模式入口，封装`Engine`提供简化的服务端接口
+ **功能**: 
    - 信号处理和优雅关闭(`Spin()`, `waitSignal()`)
    - 自定义信号等待器设置
    - 屏蔽内部复杂性，提供统一的服务端启动接口

**Engine (真正的服务端实例)**
+ **职责**: 核心服务端引擎，管理整个HTTP服务的生命周期
+ **功能**:
    - 路由管理(`trees MethodTrees`)
    - 传输层管理(`transport`)
    - 请求上下文池管理(`ctxPool`)
    - 中间件和处理器链管理
    - 服务注册与发现集成
    - 协议栈管理(`protocolServers`)

**Options (集成配置信息)**
+ **职责**: 集中管理服务端的所有配置选项
+ **功能**:
    - 网络配置(`Network`, `Addr`)
    - 超时配置(`ReadTimeout`, `WriteTimeout`)
    - 服务注册配置(`Registry`, `RegistryInfo`)
    - 传输层配置(`TransporterNewer`)
    - 其他各种服务端选项

**Registry (服务注册中心)**
+ **职责**: 服务注册与发现的抽象接口
+ **功能**:
    - 服务注册(`Register`)
    - 服务注销(`Deregister`)
    - 支持多种注册中心实现(etcd, consul等)

**RouterGroup (路由组实例)**
+ **职责**: 提供层次化的路由管理，支持中间件共享
+ **功能**:
    - 路由分组(`Group`)
    - HTTP方法路由(`GET`, `POST`等)
    - 中间件管理(`Use`)
    - 路径前缀管理

**router (路由树)**
+ **职责**: 基于HTTP方法的路由树，实现高效路由匹配
+ **功能**:
    - 路由添加(`addRoute`)
    - 路由查找(`find`)
    - 参数提取
    - 使用radix tree数据结构优化性能

**node (路由树节点)**
+ **职责**: radix tree的节点实现
+ **功能**:
    - 静态路由匹配(`skind`)
    - 参数路由匹配(`pkind`)  
    - 通配符路由匹配(`akind`)
    - 处理器链存储(`handlers`)
    - 参数名存储(`pnames`)

**Transporter (通信模块接口)**
+ **职责**: 网络传输层的抽象接口
+ **功能**:
    - 监听和服务(`ListenAndServe`)
    - 优雅关闭(`Shutdown`)
    - 立即关闭(`Close`)

**netpoll.transporter (基于netpoll的实现)**
+ **职责**: 基于cloudwego/netpoll的高性能网络实现
+ **功能**:
    - 事件驱动的网络I/O
    - 连接池管理
    - 零拷贝优化

**EventLoop (事件循环处理模块)**
+ **职责**: netpoll中的核心事件循环
+ **功能**:
    - epoll/kqueue事件处理
    - 连接生命周期管理
    - 异步I/O处理


### 请求处理时序

@startuml Hertz注册和调用时序图

participant "Client" as C
participant "Hertz" as H
participant "Engine" as E
participant "Registry" as R
participant "Transporter" as T
participant "Router" as RT
participant "Handler" as HD

== 服务注册阶段 ==
C -> H: server.New(opts...)
H -> E: route.NewEngine(options)
E -> E: 初始化路由树、传输层等

C -> H: h.Spin()
H -> H: initOnRunHooks(errChan)
note right: 设置注册钩子，延迟1秒执行
H -> E: h.Run()
E -> E: Init() - 初始化协议栈
E -> E: MarkAsRunning()
E -> T: listenAndServe()
T -> T: 创建监听器并启动服务

group 并行执行
  E -> R: Registry.Register(RegistryInfo)
  note right: 通过钩子异步注册服务
else
  T -> T: 等待连接请求
end

== 请求处理阶段 ==
C -> T: HTTP Request
T -> E: onData(ctx, conn)
E -> E: Serve(ctx, conn)
E -> RT: 路由匹配
RT -> RT: find(path, params)
RT -> E: 返回匹配结果(handlers, params)
E -> HD: 执行中间件链和处理器
HD -> E: 返回响应
E -> T: 写入响应数据
T -> C: HTTP Response

== 服务注销阶段 ==
C -> H: h.Shutdown(ctx)
H -> E: engine.Shutdown(ctx)

group 并行执行
  E -> E: executeOnShutdownHooks(ctx)
else
  E -> R: Registry.Deregister(RegistryInfo)
  note right: 从注册中心注销服务
end

E -> T: transport.Shutdown(ctx)
T -> T: 关闭监听器，等待连接关闭
T -> E: 完成关闭

@enduml

这种设计体现了几个重要的设计模式：
- **外观模式**: Hertz 作为 Engine 的外观，简化使用接口
- **策略模式**: Transporter 接口支持不同网络实现
- **对象池模式**: RequestContext 的池化管理提升性能
- **模板方法模式**: 中间件链的统一执行模式

## 路由系统深度解析
@startuml
skinparam linetype ortho
skinparam backgroundColor #f4eafa
skinparam rectangle {
  BackgroundColor #e5f2fb
  BorderColor Black
}

' 左侧的 URL 列表
rectangle "  /search/v1\n  /search/v2\n  /search\n  /see\n\n  /apple\n  /app\n\n  /bar\n  /banana" as URLList

' Radix Tree 树结构
rectangle "/" as root {
}

' 第一层
rectangle "ba" as ba
rectangle "se" as se
rectangle "app" as app

root -down-> ba
root -down-> se
root -down-> app

' ba 子节点
rectangle "r" as bar
rectangle "nana" as banana
ba -down-> bar
ba -down-> banana

' se 子节点
rectangle "e" as see
rectangle "arch" as search_arch
se -down-> see
se -down-> search_arch

' search_arch 子节点
rectangle "/v" as v
search_arch -down-> v

rectangle "1" as v1
rectangle "2" as v2
v -down-> v1
v -down-> v2

' app 子节点
rectangle "le" as apple
app -down-> apple

' 左边添加箭头和手指
URLList -right-> root : add
note left of URLList
注册的路由
end note

@enduml

### 路由注册机制

Hertz 的路由注册采用压缩前缀树（Radix Tree）数据结构，实现了高效的路由存储和查找。

```go
h := server.Default()
h.GET("/ping", func(c context.Context, ctx *app.RequestContext) {
    ctx.JSON(consts.StatusOK, utils.H{"ping": "pong"})
})
```

这里有个值得思考的细节：**为什么方法名是 `GET` 而不是 `RegisterGet`？**

从框架设计角度看，这体现了很好的 API 设计哲学：
- 对于框架开发者，这确实是一个"注册"逻辑
- 对于使用者，关注点是"声明处理一个 GET 请求"
- `GET` 这个命名更贴近用户的心理模型，避免了将框架内部概念暴露给用户

另外，Gin框架用的就是GET()；原生net/http是http.HandleFunc("/ping", pingHandler)。这里更贴近Gin的实现。

路由注册过程涉及以下核心逻辑：

1. **路径解析**: 识别静态路径、参数路径和通配符路径
2. **树构建**: 将路径按照前缀关系构建为压缩前缀树
3. **Handler 绑定**: 将处理函数链绑定到叶子节点

### 路由查找算法

路由查找是 HTTP 框架的性能关键路径，Hertz 通过优化的前缀树遍历算法实现了高效匹配：

**匹配优先级**: 静态路径 > 参数路径 > 通配符路径

**核心查找流程**:
1. 从根节点开始遍历
2. 比较请求路径与节点前缀
3. 根据匹配结果决定下一步操作：
   - 完全匹配：返回当前节点
   - 前缀匹配：递归遍历子节点
   - 不匹配：尝试参数或通配符节点

**回溯机制**: 当静态匹配失败时，算法会回溯到父节点尝试参数匹配或通配符匹配，确保找到最佳匹配结果。

#### 关于 goto 的使用

在路由查找的源码中，你会发现大量的 `goto` 语句。初看可能觉得不够优雅，但深入分析后发现这种使用是合理的：

1. **算法复杂性**: 路由匹配需要在静态、参数、通配符三种模式间跳转
2. **回溯需求**: 匹配失败时需要快速跳转到其他处理逻辑
3. **性能关键**: 这是框架的核心路径，goto 避免了复杂的状态机实现

相比用循环和状态变量实现，goto 在这里反而让代码更直观。

## 静态文件服务

Hertz 提供了功能完整的静态文件服务器，支持目录索引、文件压缩、缓存等高级特性。

```go
h.StaticFS("/", &app.FS{Root: "./", GenerateIndexPages: true})
```

### 智能缓存机制

![](https://cdn.nlark.com/yuque/__puml/ecf6a92b1e130c5b9cef8bbc4b3661a1.svg)

文件系统实现了多层缓存优化：
- **元信息缓存**: 缓存文件的 stat 信息，避免重复系统调用
- **Content-Type 缓存**: 缓存 MIME 类型检测结果
- **压缩缓存**: 缓存预压缩的文件内容

**性能优化效果**

| 操作类型 | 无缓存耗时 | 缓存命中耗时 | 性能提升 |
|---------|------------|-------------|----------|
| 系统调用 | 0.1-1ms | 0.001ms | 100-1000x |
| Content-Type检测 | 0.01-0.1ms | 0.001ms | 10-100x |
| 文件压缩 | 10-1000ms | 0.001ms | 10000-1000000x |

### 缓存机制的思考

默认缓存文件元信息 10 秒，这个设计值得讨论：

**优势**: 
- 大幅减少系统调用开销
- 对于静态资源场景性能提升明显

**潜在问题**:
- 文件更新后可能需要等待 10 秒才能看到变化
- 带 `If-Modified-Since` 的请求可能看到过期缓存

不过在实际业务场景中，静态文件的更新频率通常较低，这种权衡是合理的。就像数据库的主从延迟一样，需要在实时性和性能之间找到平衡。

## 服务注册与发现

Hertz 内置了服务注册中心的集成机制，支持多种注册中心实现。

### 注册时机设计的思考

服务注册采用延迟触发机制：在服务启动后延迟 1 秒执行注册逻辑。初看这个设计可能觉得不够严谨，但深入思考后发现是实用主义的体现。

**为什么是 1 秒延迟？**

```go
func (h *Hertz) initOnRunHooks(errChan chan error) {
	// add register func to runHooks
	opt := h.GetOptions()
	h.OnRun = append(h.OnRun, func(ctx context.Context) error {
		go func() {
			// delay register 1s
			time.Sleep(1 * time.Second)
			if err := opt.Registry.Register(opt.RegistryInfo); err != nil {
				hlog.SystemLogger().Errorf("Register error=%v", err)
				// pass err to errChan
				errChan <- err
			}
		}()
		return nil
	})
}
```

```go
// Spin runs the server until catching os.Signal or error returned by h.Run().
func (h *Hertz) Spin() {
	errCh := make(chan error)
	h.initOnRunHooks(errCh)
	go func() {
		errCh <- h.Run()
	}()

	signalWaiter := waitSignal
	if h.signalWaiter != nil {
		signalWaiter = h.signalWaiter
	}

	if err := signalWaiter(errCh); err != nil {
		hlog.SystemLogger().Errorf("Receive close signal: error=%v", err)
		if err := h.Engine.Close(); err != nil {
			hlog.SystemLogger().Errorf("Close error=%v", err)
		}
		return
	}

	if err := h.Shutdown(context.Background()); err != nil {
		hlog.SystemLogger().Errorf("Shutdown error=%v", err)
	}
}
```

```markdown
Spin()
  ├── initOnRunHooks(errCh)     // 设置延迟注册钩子  
  ├── go h.Run()                // 在goroutine中执行
  │    ├── Init()               // 初始化
  │    ├── 执行OnRun钩子         // 启动延迟注册goroutine
  │    ├── MarkAsRunning()      // 标记运行状态
  │    └── listenAndServe()     // ← 永远阻塞在这里！
  └── waitSignal(errCh)         // 主线程等待信号
```

关键问题是 `Run()` 方法会阻塞在 `listenAndServe()`，无法实现"启动完成后通知"的机制。

**对比 Spring Boot 的事件驱动方式**:
```java
@EventListener(WebServerInitializedEvent.class)
public void onWebServerReady(WebServerInitializedEvent event) {
    // 精确在Web服务器启动完成后触发注册
    serviceRegistry.register(...);
}
```

```java
ApplicationStartingEvent          // 应用开始启动
  ↓
ApplicationEnvironmentPreparedEvent  // 环境准备完成
  ↓  
ApplicationContextInitializedEvent   // 上下文初始化
  ↓
ApplicationPreparedEvent            // 应用准备完成
  ↓
ApplicationStartedEvent             // 应用启动完成
  ↓
WebServerInitializedEvent           // Web服务器初始化完成 ← 服务注册触发点
  ↓
ApplicationReadyEvent               // 应用完全就绪
```

虽然 Spring 的事件驱动方式更精确，但考虑到：
1. Hertz 的启动逻辑相对简单，不会线性增长
2. 1 秒对大多数场景都足够
3. 实现复杂度低，稳定可靠

这种权衡是合理的。过度设计有时不如简单有效的方案。

## 请求处理机制

### 连接复用与 Keep-Alive

这里有个有趣的发现：`onData` 方法使用 for 循环处理请求。

```go
func (engine *Engine) onData() {
    // 从连接池获取 RequestContext
    ctx := engine.ctxPool.Get().(*RequestContext)
    
    // 循环处理同一连接上的多个请求
    for {
        // 处理单个请求
        if !keepAlive {
            break
        }
    }
}
```

**为什么需要循环？**

这体现了对 HTTP/1.1 Keep-Alive 特性的深度优化。在传统的"一请求一连接"模式下，每个请求都需要建立新的 TCP 连接。而 Keep-Alive 允许在同一个 TCP 连接上处理多个 HTTP 请求。

这个 for 循环的设计让我想到：`onData` 处理的其实是一个 **TCP 连接的生命周期**，而不是单个 HTTP 请求。这种设计大幅减少了连接建立开销。

### RequestContext 设计

RequestContext 是框架的核心数据结构，承载了请求处理的全部上下文信息：

**核心组件**:
- **Request/Response**: 请求和响应数据
- **Handlers**: 中间件和处理函数链
- **Keys**: 用户自定义数据存储

**中间件执行机制**:
```go
func (ctx *RequestContext) Next(c context.Context) {
    ctx.index++
    for ctx.index < int8(len(ctx.handlers)) {
        ctx.handlers[ctx.index](c, ctx)
        ctx.index++
    }
}
```

这个设计很巧妙：通过索引控制执行顺序，允许中间件实现前置和后置处理：

```go
func middleware(c context.Context, ctx *app.RequestContext) {
    // 前置处理
    ctx.Next(c)
    // 后置处理
}
```

### 双 Context 设计的哲学

一个值得深入思考的问题：**为什么不把 `context.Context` 和 `app.RequestContext` 合并？**

Hertz 采用了双 Context 设计：
- **context.Context**: 处理 goroutine 生命周期、取消信号、超时控制
- **app.RequestContext**: 专门处理 HTTP 请求/响应

这种分离设计的智慧：

1. **职责清晰**: 各自负责不同层面的关注点
2. **性能考虑**: RequestContext 可能很大，对象池优化更容易
3. **兼容性**: 保持与标准库 context 的兼容

虽然两者都可以存储键值对，但这种分离避免了"大而全"带来的复杂性。有时候，清晰的职责分离比统一的接口更重要。

## 技术亮点与思考

1. **高性能架构**: 基于 Netpoll 的事件驱动网络模型
2. **智能路由**: 压缩前缀树实现的高效路由匹配
3. **连接复用**: 充分利用 HTTP Keep-Alive 提升性能
4. **多层缓存**: 文件服务的智能缓存机制
5. **设计模式**: 合理运用多种设计模式提升代码质量

## 结语

通过深入 Hertz 的源码，我看到了很多有趣的设计权衡。有些地方可能初看不够"完美"（比如 1 秒延迟注册），但仔细思考后发现是实用主义的体现。

好的框架设计不是追求理论上的完美，而是在复杂性、性能、可维护性之间找到最佳平衡点。Hertz 的设计充分体现了这种工程智慧，值得我们深入学习和借鉴。

在技术选择上，有时候简单有效比复杂精确更重要；在 API 设计上，用户体验比技术纯度更重要。这些都是 Hertz 源码给我的启发。 