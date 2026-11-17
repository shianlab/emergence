# 1.02 外部电脑验收

目标：验证其他 Windows x64 电脑上的真实安装、首次配置和一次任务。开发机测试不能代替本表。不要提供 API 密钥、聊天历史或私有项目内容。

## 准备

使用本轮验收对应的 `Emergence-1.0.2-win32-x64.zip` 和同名 `.sha256`，不能使用 GitHub 的 Source code ZIP。候选正式公开前由项目维护者提供这两个文件；公开后需补测官方入口的实际下载。先计算哈希，和摘要文件比较：

```powershell
Get-FileHash .\Emergence-1.0.2-win32-x64.zip -Algorithm SHA256
```

建议至少一位没有开发版 Node/npm 的用户验证。旧用户记录原版本与安装位置即可，不要先卸载或删除配置。

## 操作

1. 记录 Windows 版本、终端类型、PowerShell 版本（`$PSVersionTable.PSVersion`），以及首次安装或从哪个版本升级。
2. 解压 ZIP，在解压后的发行文件夹运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`。自定义安装目录的旧用户添加 `-InstallRoot "原安装目录"`。记录大致耗时、最后提示和是否出现报错。
3. 新开终端执行 `emergence --version`，应显示 `1.0.2`，随后进入一个临时项目目录运行 `emergence`。
4. 用 `/model-config` 添加自己的模型，保存后发送“请在当前目录创建 hello.txt，内容为 hello，并读取确认”。按权限提示确认；检查实际文件内容以及回复。
5. 打开 `/update`，确认菜单能用 Enter 选择、Esc 返回，原输入草稿保留。正式稳定清单未上线时，检查可能提示暂不可用；这不能算正式公网更新验收通过。
6. 旧用户检查原来的模型、密钥是否仍可用，以及一条旧会话能否打开。可选：执行 `emergence installation status` 查看状态；有上一版本时验证 `emergence rollback`，再重跑候选安装回到 1.0.2。

## 回传结果

```text
Windows / 终端 / PowerShell：
首次安装，或原版本及自定义路径：
下载来源及耗时（若从官方网络下载）：
安装耗时及是否成功：
emergence --version：
原生模型配置能否打开、保存：
是否完成真实 hello.txt 写入与读取：
旧模型 / 历史是否保留（旧用户）：
/update 菜单结果：
是否需要额外修复；如有，报错与实际操作：
```

报错时保留完整错误文字和安装诊断的阶段/耗时即可，勿发送密钥。无法启动时可用完整包重新运行安装器；不要让其他工具盲目删除安装目录或修改凭据。

仅收到“能打开”不足以验收：必须确认配置模型和完成一次实际任务。文件传输安装通过也不等同于 GitHub 弱网下载通过；两项分开记录。
