using System.Threading.Tasks;

namespace Emergence.ModelConfiguration
{
    sealed partial class ConfigurationForm
    {
        async Task RefreshState()
        {
            state = await connection.Call("/api/state", null);
            editing = false;
            ResetRules();
            Render();
            Notice("状态已刷新");
        }

        async Task RemoveModel()
        {
            state = await connection.Call("/api/models/remove", new
            {
                revision = Json.Str(state, "revision"),
                id = selected
            });
            dirty = false;
            secret = "";
            editing = false;
            ResetRules();
            Render();
            Notice("模型已删除。");
        }

        async Task TestConnection()
        {
            CaptureDraft();
            ValidateDraft();
            Notice("正在连接，最多等待 20 秒…");
            var result = await connection.Call("/api/test", new
            {
                model = draft,
                secret = secret
            });
            Notice((Json.Yes(result, "ok") ? "✓ " : "× ") + Json.Str(result, "message") +
                " · " + Json.Str(result, "elapsedMs") + " ms");
        }

        async Task SaveModel()
        {
            CaptureDraft();
            ValidateDraft();
            state = await connection.Call("/api/models/save", new
            {
                revision = Json.Str(state, "revision"),
                model = draft,
                secret = secret
            });
            dirty = false;
            secret = "";
            editing = false;
            ResetRules();
            Render();
            var warning = Json.Str(state, "credentialWarning");
            Notice(warning.Length > 0 ? warning : "模型已保存" +
                (Json.Yes(state, "live") ? "，当前工作台已更新。" : "，下次启动即可使用。"));
        }

        async Task SaveDefaults()
        {
            state = await connection.Call("/api/defaults", new
            {
                revision = Json.Str(state, "revision"),
                defaultModel = defaultId,
                windowModels = rules
            });
            ResetRules();
            Render();
            Notice("默认规则已保存，将用于新建窗口。");
        }

        async Task AssignWindow(string windowId, string modelId, string number)
        {
            state = await connection.Call("/api/windows/assign", new
            {
                revision = Json.Str(state, "revision"),
                windowId = windowId,
                modelId = modelId
            });
            RenderWindows();
            Fit();
            Notice("已应用到窗口 " + number + "，下一轮使用所选模型；会话历史保留。");
        }
    }
}
