# LangGraph中的interrupt实现人机交互（HITL）
[https://zhuanlan.zhihu.com/p/15890714100](https://zhuanlan.zhihu.com/p/15890714100) 前序知识

本文主要关注于内部实现，不涉及基本使用

## 1. 概述
LangGraph是一个构建基于LLM的多步工作流的框架，它提供了一个强大的人机交互（Human-In-The-Loop，HITL）功能，允许开发者创建可中断和可恢复的工作流。本文档将深入分析interrupt机制的实现原理、关键概念以及典型用例。

## 2. 核心概念
### 2.1 StateGraph与节点
LangGraph使用有向图来表示工作流程，图中的节点代表计算步骤，边表示执行流程。一个典型的图结构由以下部分组成：

+ **StateGraph**：主要图形类，管理节点和边
+ **Node**：图中的节点，代表某个特定的计算或决策步骤
+ **Edge**：连接节点的边，表示执行流程
+ **State**：在节点之间共享的状态对象

### 2.2 中断机制（Interrupt）
LangGraph通过`interrupt()`函数提供了一种暂停和恢复图执行的能力。当在节点执行过程中调用此函数时，图的执行将暂停，并向客户端返回一个带有上下文信息的值。

### 2.3 恢复机制（Resume）
通过使用`Command`原语和`resume`参数，客户端可以提供恢复值并继续执行。图会从中断的节点处恢复执行。

## 3. 工作原理
### 3.1 中断调用流程


@startuml
participant "客户端" as Client
participant "Graph.invoke()" as Graph
participant "节点A" as NodeA
participant "节点B" as NodeB
participant "interrupt()" as Interrupt
participant "Checkpointer" as Checkpointer

Client -> Graph: 执行图
Graph -> NodeA: 执行节点A
NodeA --> Graph: 返回
Graph -> NodeB: 执行节点B
NodeB -> Interrupt: 调用interrupt()
Interrupt -> Checkpointer: 保存当前状态
Interrupt --> NodeB: 抛出GraphInterrupt异常
NodeB --> Graph: 传播异常
Graph --> Client: 返回中断值和中断信息
Client -> Graph: 发送Command(resume=值)
Graph -> Checkpointer: 获取中断状态
Graph -> NodeB: 从中断点恢复执行
NodeB -> Interrupt: 获取resume值
Interrupt --> NodeB: 返回resume值
NodeB --> Graph: 执行完成并返回
Graph --> Client: 返回最终结果
@enduml


### 3.2 中断实现的核心组件
1. **interrupt()函数**：用于从节点内部触发中断
2. **GraphInterrupt异常**：中断执行的内部机制
3. **PregelScratchpad**：管理恢复值和中断计数的组件
4. **Command**：用于从客户端提供恢复值
5. **Checkpointer**：保存和恢复执行状态的机制

## 4. 实现细节
### 4.1 interrupt()函数实现
`interrupt()`函数是中断机制的核心，实现在`langgraph/libs/langgraph/langgraph/types.py`中：

```python
def interrupt(value: Any) -> Any:
    """中断图的执行，并返回一个可恢复的异常"""
    # 获取配置
    conf = get_config()["configurable"]
    # 跟踪中断索引
    scratchpad: PregelScratchpad = conf[CONFIG_KEY_SCRATCHPAD]
    idx = scratchpad.interrupt_counter()
    
    # 查找先前的恢复值
    if scratchpad.resume:
        if idx < len(scratchpad.resume):
            return scratchpad.resume[idx]
    
    # 查找当前恢复值
    v = scratchpad.get_null_resume(True)
    if v is not None:
        assert len(scratchpad.resume) == idx
        scratchpad.resume.append(v)
        conf[CONFIG_KEY_SEND]([(RESUME, scratchpad.resume)])
        return v
    
    # 没有恢复值，抛出中断异常
    raise GraphInterrupt(
        (
            Interrupt(
                value=value,
                resumable=True,
                ns=cast(str, conf[CONFIG_KEY_CHECKPOINT_NS]).split(NS_SEP),
            ),
        )
    )
```

### 4.2 PregelScratchpad
PregelScratchpad负责管理节点的中断计数和恢复值：

```python
@dataclasses.dataclass
class PregelScratchpad:
    # 函数调用计数器
    call_counter: Callable[[], int]
    # 中断计数器
    interrupt_counter: Callable[[], int]
    get_null_resume: Callable[[bool], Any]
    resume: list[Any]
    # 子图计数器
    subgraph_counter: Callable[[], int]
```

### 4.3 Command类
客户端使用Command类来提供恢复值：

```python
@dataclasses.dataclass
class Command(Generic[N], ToolOutputMixin):
    """更新图状态和向节点发送消息的命令"""
    graph: Optional[str] = None
    update: Optional[Any] = None
    resume: Optional[Union[dict[str, Any], Any]] = None
    goto: Union[Send, Sequence[Union[Send, N]], N] = ()
```

## 5. 回答您的问题
### 5.1 如何实现A->B->C的graph，B interrupt之后恢复时A不再执行
LangGraph通过checkpoint机制和执行状态跟踪实现这一功能：

1. **图执行和状态跟踪**：
    - 当图在执行时，每个节点的状态都会通过checkpointer保存
    - Checkpointer记录了执行到哪个节点，以及该节点的执行状态
2. **节点标识和命名空间**：
    - 每个节点都有一个唯一的命名空间(namespace)，形式为`node_name:uuid`
    - 中断发生时，GraphInterrupt异常会包含节点的命名空间信息
3. **恢复机制的实现**：
    - 当使用Command(resume=...)恢复执行时，LangGraph会从checkpointer获取上次的执行状态
    - 它会直接从中断的节点B开始执行，而不是从头开始
    - 这是通过检查checkpoint_ns和threadId实现的
4. **关键实现代码**：在PregelLoop._first方法中，它检查是否从先前的checkpoint恢复:

```python
# 从先前checkpoint恢复需要:
# - 找到先前的checkpoint
# - 接收None输入(外部图)或RESUMING标志(子图)
is_resuming = bool(self.checkpoint["channel_versions"]) and bool(
    configurable.get(
        CONFIG_KEY_RESUMING,
        self.input is None
        or isinstance(self.input, Command)
        or (
            not self.is_nested
            and self.config.get("metadata", {}).get("run_id")
            == self.checkpoint_metadata.get("run_id", MISSING)
        ),
    )
)
```

如果是从checkpoint恢复，它会跳过已执行的A节点，直接从B节点开始。

### 5.2 如何实现一个node多次interrupt
通过PregelScratchpad的interrupt_counter计数器和resume值列表实现：

1. **中断计数器**：
    - 每个节点维护一个interrupt_counter
    - 每次调用interrupt()时，计数器递增
    - 计数器值用于为每个interrupt匹配正确的resume值
2. **恢复值列表**：
    - 多个恢复值存储在scratchpad.resume列表中
    - 当从多个interrupt恢复时，resume值按照原始中断的顺序匹配
3. **示例代码解析**：

```python
def human_node(state: State):
    print(f"[human_node-before] state: {state}")
    for i in range(2):
        value = interrupt({"text_to_revise": state["some_text"]})
    print(f"[human_node-after] value: {value}")
    return {"some_text": value}
```

在这个函数中：

+ 第一次调用interrupt()会抛出GraphInterrupt异常并暂停执行
+ 当使用resume值恢复时，函数从头开始执行，但interrupt()会返回恢复值而不是再次抛出异常
+ 第二次调用interrupt()，如果没有第二个恢复值，会再次抛出异常
+ 当提供第二个恢复值时，函数将完全执行

@startuml
participant "客户端" as Client
participant "Graph" as Graph
participant "human_node" as Node
participant "interrupt()" as Interrupt
participant "PregelScratchpad" as Scratchpad

Client -> Graph: invoke(...)
Graph -> Node: 执行节点
Note over Node: for i in range(2):
Node -> Interrupt: interrupt(值1)
Interrupt -> Scratchpad: idx = interrupt_counter() # 返回0
Interrupt -> Scratchpad: 检查是否有resume[0]
Interrupt <-- Scratchpad: 没有resume值
Interrupt --> Node: 抛出GraphInterrupt异常
Node --> Graph: 传播异常
Graph --> Client: 返回中断信息

Client -> Graph: invoke(Command(resume="回复1"))
Graph -> Node: 从头开始执行节点
Note over Node: for i in range(2):
Node -> Interrupt: interrupt(值1)
Interrupt -> Scratchpad: idx = interrupt_counter() # 返回0
Interrupt -> Scratchpad: 检查是否有resume[0]
Interrupt <-- Scratchpad: 返回"回复1"
Interrupt --> Node: 返回"回复1"
Node -> Interrupt: interrupt(值2)
Interrupt -> Scratchpad: idx = interrupt_counter() # 返回1
Interrupt -> Scratchpad: 检查是否有resume[1]
Interrupt <-- Scratchpad: 没有resume值
Interrupt --> Node: 抛出GraphInterrupt异常
Node --> Graph: 传播异常
Graph --> Client: 返回中断信息

Client -> Graph: invoke(Command(resume="回复2"))
Graph -> Node: 从头开始执行节点
Note over Node: for i in range(2):
Node -> Interrupt: interrupt(值1)
Interrupt -> Scratchpad: idx = interrupt_counter() # 返回0
Interrupt -> Scratchpad: 检查是否有resume[0]
Interrupt <-- Scratchpad: 返回"回复1"
Interrupt --> Node: 返回"回复1"
Node -> Interrupt: interrupt(值2)
Interrupt -> Scratchpad: idx = interrupt_counter() # 返回1
Interrupt -> Scratchpad: 检查是否有resume[1]
Interrupt <-- Scratchpad: 返回"回复2"
Interrupt --> Node: 返回"回复2"
Node --> Graph: 执行完成并返回
Graph --> Client: 返回最终结果
@enduml

### 5.3 为什么可以new一个新的graph，但需要checkpointer和config中thread_id一致才能从interrupt中恢复
这涉及到LangGraph的持久化执行模型：

1. **Checkpointer的作用**：
    - Checkpointer负责持久化存储图执行状态
    - 它将状态与thread_id和checkpoint命名空间关联
2. **状态的存储方式**：
    - 在InMemorySaver实现中，状态存储在一个映射结构中：  
`storage: defaultdict[str, dict[str, dict[str, tuple[tuple[str, bytes], tuple[str, bytes], Optional[str]]]]]`
    - 这是一个三层嵌套结构：thread_id -> checkpoint_ns -> checkpoint_id -> checkpoint数据
3. **thread_id的重要性**：
    - thread_id是查找checkpoint的主键
    - 不同的thread_id对应不同的执行上下文
    - 即使创建新的图实例，相同的thread_id可以访问相同的持久化状态
4. **配置一致性**：
    - config中的thread_id标识一个特定的执行流
    - 当重新创建图时，如果使用相同的checkpointer和thread_id，新图可以访问原有的执行状态
    - 这允许在完全不同的进程甚至不同的机器上恢复执行
5. **关键实现代码**：在InMemorySaver.get_tuple方法中：

```python
def get_tuple(self, config: RunnableConfig) -> Optional[CheckpointTuple]:
    """从内存存储中获取checkpoint元组"""
    thread_id: str = config["configurable"]["thread_id"]
    checkpoint_ns: str = config["configurable"].get("checkpoint_ns", "")
    if checkpoint_id := get_checkpoint_id(config):
        if saved := self.storage[thread_id][checkpoint_ns].get(checkpoint_id):
            # 返回与thread_id和checkpoint_id关联的checkpoint
            # ...
```

这种设计使得LangGraph能够支持多种部署场景，包括分布式执行、故障恢复和跨会话持久性。

@startuml
package "第一个应用实例" {
  [StateGraph] as Graph1
  [Checkpointer] as Checkpointer1
}

package "第二个应用实例" {
  [StateGraph] as Graph2
  [Checkpointer] as Checkpointer2
}

database "持久化存储" {
  folder "thread_id_1" {
    [checkpoint_data_1]
  }
  folder "thread_id_2" {
    [checkpoint_data_2]
  }
}

[Graph1] --> [Checkpointer1] : 使用
[Graph2] --> [Checkpointer2] : 使用
[Checkpointer1] --> [checkpoint_data_1] : 存取(thread_id=1)
[Checkpointer2] --> [checkpoint_data_1] : 存取(thread_id=1)

note bottom of [checkpoint_data_1]
  相同的thread_id意味着
  访问相同的执行状态
end note
@enduml

## 6. 最佳实践
### 6.1 适用场景
+ 需要人类审核或输入的工作流程
+ 长时间运行的流程需要中间交互
+ 多步骤表单或问卷流程
+ 审批工作流

### 6.2 设计考虑
+ 确保中断值提供足够的上下文信息
+ 在适当的粒度使用中断
+ 为每个interrupt提供有意义的恢复路径
+ 使用合适的checkpointer实现（生产环境建议使用PostgresSaver）

## 7. 结论
LangGraph的interrupt机制提供了一种优雅的方式来实现人机交互（HITL）工作流。通过将状态持久化与执行流程控制相结合，它实现了一个既灵活又强大的系统，允许开发者创建复杂的、交互式的应用程序。关键的设计决策包括：

1. 使用命名空间和thread_id来标识执行上下文
2. 通过PregelScratchpad跟踪多个中断和恢复值
3. 将执行状态与图实例分离，允许跨实例恢复

这些特性使LangGraph成为构建现代、交互式AI应用程序的强大工具。

## 8. 参考资源
+ [LangGraph 官方文档](https://python.langchain.com/docs/langgraph/)
+ [LangGraph Interrupt API 参考](https://python.langchain.com/docs/langgraph/reference/types/#langgraph.types.interrupt)
+ [人机交互工作流程示例](https://python.langchain.com/docs/langgraph/how-tos/human-in-the-loop)

