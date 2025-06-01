import { navbar } from "vuepress-theme-hope";

export default navbar([
  "/",
  {
    text: "博客",
    icon: "pen-to-square",
    prefix: "/posts/",
    children: [
      {
        text: "LangGraph",
        icon: "pen-to-square",
        prefix: "langgraph/",
        children: [
          {
            text: "LangGraph中的interrupt实现人机交互（HITL）",
            icon: "pen-to-square",
            link: "langgraph_interrupt",
          },
        ],
      },
      { text: "Hertz 源码学习笔记", icon: "pen-to-square", link: "hertz" },
      // {
      //   text: "苹果",
      //   icon: "pen-to-square",
      //   prefix: "apple/",
      //   children: [
      //     { text: "苹果1", icon: "pen-to-square", link: "1" },
      //     { text: "苹果2", icon: "pen-to-square", link: "2" },
      //     "3",
      //     "4",
      //   ],
      // },
      // {
      //   text: "香蕉",
      //   icon: "pen-to-square",
      //   prefix: "banana/",
      //   children: [
      //     {
      //       text: "香蕉 1",
      //       icon: "pen-to-square",
      //       link: "1",
      //     },
      //     {
      //       text: "香蕉 2",
      //       icon: "pen-to-square",
      //       link: "2",
      //     },
      //     "3",
      //     "4",
      //   ],
      // },
      // { text: "樱桃", icon: "pen-to-square", link: "cherry" },
      // { text: "火龙果", icon: "pen-to-square", link: "dragonfruit" },
      // "tomato",
      // "strawberry",
    ],
  },
]);
