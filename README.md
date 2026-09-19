# 摸鱼小游戏合集

纯静态的浏览器小游戏合集，不用安装、点开就玩。当前包含一款游戏：**小熊猫摘星星**。

在线访问：[摸鱼小游戏合集](https://paratroopery.github.io/web_games/)

完整玩法与设计取舍见 [设计文档](docs/DESIGN.md)。

## 目录结构

```
web_games/
├── index.html              合集首页，卡片式入口
├── games.css               首页样式
├── assets/
│   ├── canon.mid           内置曲目：卡农（D 大调）
│   └── *图.png             角色动作参考图
├── docs/DESIGN.md          游戏设计文档（玩法、物理参数、里程碑）
└── star-collector/         小熊猫摘星星
    ├── index.html          游戏页（首页 / 帮助 / 音乐选择面板）
    ├── game.js             游戏主体：物理、阶梯生成、渲染、音乐模式
    ├── game.css            游戏页样式
    ├── midi.js             自研极简 MIDI 解析器，输出音符事件
    ├── midi-lab.html       MIDI 解构实验室（调试工具，无入口链接，需手动访问）
    ├── assets/             角色精灵图（站立 / 上升 / 下落）
    └── vendor/             WebAudioFont 播放器与钢琴音源
```

## 本地运行

游戏用 `fetch` 加载内置 MIDI，**必须通过 HTTP 访问**，直接双击打开 `index.html`（`file://` 协议）会导致音乐功能不可用，页面顶部会给出提示。

在项目根目录启动任意静态服务器：

```bash
python -m http.server 8000
```

或

```bash
npx serve .
```

然后浏览器打开：

- 合集首页 `http://localhost:8000/`
- 单游戏页 `http://localhost:8000/star-collector/`
- MIDI 实验室 `http://localhost:8000/star-collector/midi-lab.html`

无构建步骤、无依赖安装，源码即产物，可直接部署到 GitHub Pages 等静态托管。

## 操作方式

**自由模式（跳跃摘星）**

1. 单击画面从月面起跳，同时启用声音。
2. 空中移动鼠标控制左右，角色延迟约 0.1 秒跟随鼠标水平位置，键盘左右键为备用控制。
3. 踩中星星立即向上弹起并计分：第 1 颗 100 分，之后每颗递增 10 分。
4. 下落途中碰到星星同样可以自救弹起。
5. 落回月面本局结束，结算显示总分、摘星数与最高纪录。

**音乐模式（引航）**

不使用弹跳物理，改为鼠标飞行：移动鼠标缓慢漂移，按住鼠标明显加速，松开快速减速。星星横坐标对应音高，触碰最亮的星星为乐句"揭幕"，其后的旋律与伴奏按原速自动播放，播完停下等待玩家。无失败判定，曲终结算显示 perfect / good 数与演奏完成度。

切到后台自动暂停，回到页面点一下画面继续。

## 技术栈与边界

- 原生 HTML / CSS / JavaScript，Canvas 2D 渲染、Web Audio 发声，无框架、无打包工具。
- 最高纪录与设置（静音、音量、减少特效）存在浏览器 IndexedDB 中。
- 只保证最新版 Chrome / Edge / Firefox / Safari。
- 移动端触屏适配、MP3 / WAV 音频转谱、存档导出导入、用户上传 MIDI 均不在首版范围内。