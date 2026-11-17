# 第一阶段退役与兼容清单

分类依据是当前调用链及存储用途，不以名字里是否含有 team、collaboration 判断。A = 当前生产能力，B = 共享执行能力，C = 历史读取兼容，D = 仅服务已退役的跨窗口控制。一个文件可以同时包含多类职责；本阶段不删除产品实现。

## 逐项去向

路径均相对于 `emergence/`；文件级导入者与位置见 [模块清单](module-inventory.json)。下表补充静态导入无法决定的成员职责和数据条件。

| 编号 | 当前模块/职责 | 类别与实际依据 | 后续处理与退出条件 |
| --- | --- | --- | --- |
| R01 | `src/core/application/task-coordinator.ts` | B+D：Workspace.attach 将 planning.onExecute 接到 executePlan；active/admitting、取消、恢复仍用于本窗口执行 | 第三阶段保留共享执行引擎，移出主控/执行窗口管理及跨窗分配；迁移全部调用与测试后删除被替代成员，不用空协调器维持旧结构 |
| R02 | `src/core/application/team-coordinator.ts` | A+C+D：Workspace 仍构造对象；session 模式工具安装返回空列表，但 onIntake、sync、roster 和环境投影仍有引用 | 提取本会话能力/权限投影，历史记录只读兼容；解除实际调用后移出生产构造，不能整文件直接删除或永久保留空壳 |
| R03 | `src/core/application/team-followthrough.ts` | B+C+D：TaskScheduler.pump 调用 advance/allows；Coordinator 还连接 clockChanged、owner、cancelTask、close；对象读取旧协调记录 | 明确当前任务的调度资格、时钟与取消责任，迁回既有执行引擎；历史查询迁到兼容边界；删除自动协调分支前替换调用，不将 allows 无条件改成 true |
| R04 | `src/core/application/coordinator-context.ts` | D：CorePlanning.context 的主控分支引用，当前独立模式不启用该分支 | 移除旧分支和导入后可删除；普通 KIM 需求/规划上下文保留 |
| R05 | `src/core/adapters/collaboration-tools.ts` | B+D：执行钩子仍安装；workspace scope 内的主控工具已经停止向产品注册 | 保留共享执行、证据和权限钩子，移除仅跨窗控制的注册与入口；不能直接卸载整个适配器 |
| R06 | `src/core/application/assurance.ts`、`audit-allocation.ts` | B+C+D：跨窗审查 request 在 session scope 拒绝；证明、版本、报告核对仍服务任务与记忆 | 分离审查分配和证据核对。audit-allocation 只有在所有有效调用/测试迁移后才可删除；不能把证据核对一起移除 |
| R07 | `src/core/application/task-lifecycle.ts`、`src/core/storage/execution-journal.ts` | B+C：SQLite 是任务与副作用事实来源；恢复必须处理已中断和副作用未知的记录 | 保留。兼容读取不得自动恢复 master/workers 或重放外部操作；不清数据库，不将旧状态改成成功 |
| R08 | `src/core/application/planning-service.ts`、规划契约、`src/core/storage/plan-store.ts` | A+B+C+D：当前需求分析和本窗口计划必需；v1 计划解码为 blocked 的 v2；旧主控上下文混在同一流程 | 第三阶段去主控分支，第四阶段整理规划职责；保留版本解码、需求/澄清、准入、预算及真实执行回执 |
| R09 | `src/core/domain/team.ts`、`planning.ts`、`orchestration.ts` | B+C+D：planning/team 类型成环；CoordinationRecord 与角色字段同时关联历史数据和当前合同类型 | 第二阶段拆开契约依赖，第三阶段隔离历史 schema 与当前任务契约；不得因角色词汇删除有效权限/项目约束 |
| R10 | `src/app/workspace.ts`、`templates.ts`、`config.ts` 和模型默认规则 | A+C+D：恢复时清理旧控制角色，产品执行范围固定 session；同一配置还包含模型、项目与草稿 | 旧字段在读取边界处理；保留模型、密钥、独立窗口配置和历史；不引入“开启旧协作”的兼容开关 |
| R11 | `src/app/tui/team-bar.ts`、`team-feedback.ts`、`task-inspector.ts` | A+C+D：旧团队栏仍被构造但在独立模式隐藏；反馈/详情还关联任务、审批和历史记录 | 第三阶段切断旧业务投影，第五阶段清理显示；保留本窗口任务详情和审批，不用删除整个详情页代替退役 |
| R12 | `src/core/application/runtime-ports.ts` | B+D：引用具体 CodeWorkHarness 类型；WorkspacePort 暴露 team 和多个可变集合 | 第二阶段按使用者收窄契约，第三阶段去掉退役成员；不复制整个 Controller 或 Workspace 为一个巨大接口 |
| R13 | `tests/fixtures/historical-orchestration.ts` 及调用它的测试 | B+C+D：仅测试宿主恢复 workspace scope/主控入口；部分用例实际验证任务准入、证据、恢复、安全 | 按下面的测试迁移规则逐用例处理，不能按测试文件名整体删除；产品不能依赖该宿主 |
| R14 | `historical:*` 脚本、旧阶段方案与报告 | C+D：这些材料解释旧实现，不属于当前发布矩阵；当前矩阵由 inspect-full 维护 | 旧文档先标为历史，确认活动引用后再清理失效脚本；保留兼容样本、必要来源和问题记录 |
| R15 | KIM 资产、外部 Skills/MCP、Code/Data、原生子代理、独立多窗口、Windows Forms | A+B：均为当前保留能力，子代理与其他窗口是不同的归属边界 | 不纳入协同退役删除范围；保持自动需求理解、扩展权限、来源许可与资源释放 |

## 测试迁移规则

| 测试用途 | 后续处置 |
| --- | --- |
| 当前独立窗口、审批、权限、规则、Code/Data、模型配置 | 保留原行为断言，跟随契约迁移调用 |
| 借用历史宿主验证任务准入、预算、失败、恢复、执行回执 | 改用当前单会话执行宿主；保留拒绝、取消、未知副作用及重复提交边界，不只保留成功路径 |
| 旧工作台、旧计划、旧 SQLite 记录与未确认副作用 | 冻结输入样本，验证兼容读取与不自动重放；无需启用主控功能 |
| 纯主控自动派发、自动追加执行窗口、旧团队 UI | 共享能力测试迁移后，记录替代或删除去向，再退出当前测试依赖 |

第一阶段静态目录覆盖 65 个常规 `.test.ts` 文件，标题列表保存在本地 `test-catalog.json`。参数化用例会在运行时展开，静态标题数不是发布验收的 397 个运行用例数。

第三阶段每次删除要同时记录：被接管职责、原调用者去向、数据兼容入口和验证用例。未满足这些条件的混合文件只列入迁移清单，不视为垃圾。
