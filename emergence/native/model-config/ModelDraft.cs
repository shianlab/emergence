using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace Emergence.ModelConfiguration
{
    // Editor data belongs here; controls only capture and display it. Credentials stay in memory.
    sealed class ModelDraft
    {
        internal Dictionary<string, object> Value;
        internal string Selected, Secret = "";
        internal bool Editing, Dirty;

        internal void Begin(object state, string id)
        {
            Selected = id;
            Editing = true;
            Dirty = false;
            Secret = "";
            var previous = Json.Rows(state, "models").FirstOrDefault(m => Json.Str(m, "id") == id);
            Value = previous == null ? new Dictionary<string, object> {
            {"id", ""}, {"provider", ""}, {"model", ""}, {"api", "openai-completions"},
            {"baseURL", ""}, {"apiKeyEnv", ""}, {"contextWindow", 128000}, {"maxTokens", 8192}
        } : Json.Copy(previous);
            Value.Remove("credentialConfigured");
            Value.Remove("credentialSource");
        }

        internal bool Valid
        {
            get
            {
                return Regex.IsMatch(Json.Str(Value, "id"), "^[a-z0-9_-]{1,32}$") &&
                    new[] { "provider", "model", "baseURL", "apiKeyEnv" }
                        .All(name => !String.IsNullOrWhiteSpace(Json.Str(Value, name)));
            }
        }
    }
}
