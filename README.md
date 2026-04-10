# 基金策略管家 (Fund Strategy Manager)

这是一个本地运行的基金策略辅助工具，核心逻辑是使用“最近一次成交价 ±5%”给出买入/卖出提醒。

## 你现在可以直接双击启动

- 双击 [双击启动.bat](./双击启动.bat)（等价于 [Start.bat](./Start.bat)）
- 程序会自动完成：
  - 创建虚拟环境（首次）
  - 安装依赖（首次或依赖变更时）
  - 启动服务并自动打开浏览器

默认访问地址：`http://127.0.0.1:5000`

## 分享给别人（双击版）

1. 在你的电脑上双击 [一键打包分享版.bat](./一键打包分享版.bat)（等价于 [BuildShareable.bat](./BuildShareable.bat)）
2. 构建完成后，会生成：
   - `release\FundStrategyManager\` 文件夹版
   - `release\FundStrategyManager.zip` 压缩包
3. 把 `zip` 发给别人即可，对方解压后双击：
   - `DoubleClickStart.bat` 或 `FundStrategyManager.exe`

## 目录说明

- [app.py](./app.py): 后端服务与策略逻辑
- [templates/index.html](./templates/index.html): 页面结构
- [static/app.js](./static/app.js): 前端交互
- [static/style.css](./static/style.css): 页面样式
- [Start.bat](./Start.bat): 本机一键启动
- [双击启动.bat](./双击启动.bat): 中文入口脚本
- [BuildShareable.bat](./BuildShareable.bat): 一键打包分享版
- [一键打包分享版.bat](./一键打包分享版.bat): 中文打包入口脚本
- [Run_Portable.bat](./Run_Portable.bat): 分享版启动器模板

## 常用环境变量（可选）

- `FUND_HOST`：默认 `127.0.0.1`
- `FUND_PORT`：默认 `5000`
- `FUND_DEBUG`：默认 `0`
- `FUND_OPEN_BROWSER`：默认源码运行时 `0`，打包 exe 运行时 `1`

## 数据文件

- 数据库文件：`fund_strategy.db`
- 位置：
  - 源码运行时，在项目根目录
  - exe 运行时，在 exe 所在目录

## 免责声明

本工具仅用于策略执行辅助，不构成投资建议。
