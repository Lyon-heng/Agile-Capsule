# Agile Capsule

Agile Capsule 是一个 Windows 顶部灵动岛 / 刘海式信息中心：把时间、网速、天气、媒体播放和微信通知收进屏幕边缘的一条胶囊里。

## 下载

前往 [GitHub Releases](https://github.com/Lyon-heng/Agile-Capsule/releases/latest) 下载：

| 文件 | 说明 |
| --- | --- |
| `Agile-Capsule-1.0.1-portable.exe` | 便携版，双击即可运行，不需要安装 |
| `Agile-Capsule-Setup-1.0.1.exe` | 安装版，可选择安装目录，创建开始菜单和桌面快捷方式 |

系统要求：Windows 10 / 11，64 位。

## 从源码构建

```powershell
npm install
npm run dist
```

需要 Node.js 22+ 与 Windows 环境。

## 主要功能

- 顶部贴边胶囊，可切换 Windows 灵动岛与 MacBook 刘海形态
- 时间、上下行网速、天气、媒体与微信通知聚合显示
- 微信消息卡片支持 5 / 10 / 15 / 30 秒自动消失
- 下拉展开控制台：音量、播放控制、输出设备、顶部样式
- 右键菜单：打开设置、开机自启、退出
- 设置、开机自启、消息停留时间、硬件监控等本地配置

## 运行说明

便携版不会写入安装目录，直接运行即可。安装版为当前用户安装，默认创建开始菜单快捷方式；安装过程中可以更改目录。

程序当前没有代码签名证书，Windows SmartScreen 可能会在首次运行时提示“未知发布者”。这是 Electron 应用未签名的正常提示，选择“更多信息 → 仍要运行”即可。

## 隐私说明

- 发布包不包含开发者账号、访问令牌、本机用户名、本机文件路径或本机桌面截图。
- 设置保存在当前用户的本地应用数据目录，不会随发布包分发。
- 应用内的硬件预览图和网络样式预览图已经过脱敏处理，不包含具体设备型号、进程名或个人信息。
- 天气、额度等在线功能只在用户主动使用相关功能时访问对应服务。

## 校验

下载后可用 `SHA256SUMS.txt` 校验文件完整性：

```powershell
Get-FileHash .\Agile-Capsule-1.0.1-portable.exe -Algorithm SHA256
Get-FileHash .\Agile-Capsule-Setup-1.0.1.exe -Algorithm SHA256
```

## 更新记录

### 1.0.1

- 修复全屏监听脚本在 Windows PowerShell 5.1 下因 UTF-8 无 BOM 导致解析失败，应用全屏后灵动岛不隐藏的问题。
- 统一所有运行时 PowerShell 脚本为 UTF-8 BOM，避免同类编码问题。

## 许可证

MIT License，详见 `LICENSE.txt`。
