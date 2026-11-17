using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

namespace Emergence.ModelConfiguration
{
    static class NativeModelConfigurationTests
    {
        sealed class DelayedHandler : HttpMessageHandler
        {
            internal readonly TaskCompletionSource<HttpResponseMessage> Response = new TaskCompletionSource<HttpResponseMessage>();
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token)
            {
                return Response.Task;
            }
        }
        static void Check(bool valid, string message)
        {
            if (!valid)
                throw new Exception(message);
        }
        static void Main()
        {
            var model = new Dictionary<string, object> {
            {"id", "test"}, {"provider", "fixture"}, {"model", "model"},
            {"baseURL", "http://127.0.0.1"}, {"apiKeyEnv", "FIXTURE_KEY"},
            {"credentialConfigured", true}, {"credentialSource", "stored"}
        };
            var state = new Dictionary<string, object> { { "models", new object[] { model } } };
            var draft = new ModelDraft();
            draft.Begin(state, "test");
            Check(draft.Valid, "existing model must remain valid");
            Check(!draft.Value.ContainsKey("credentialConfigured"), "display metadata cannot become saved configuration");
            draft.Value["provider"] = "edited";
            Check(Json.Str(model, "provider") == "fixture", "editing must not mutate loaded state");
            draft.Secret = "temporary";
            draft.Dirty = true;
            draft.Begin(state, null);
            Check(!draft.Valid && !draft.Dirty && draft.Secret == "" && draft.Selected == null, "new editor must clear prior state");
            Check(Convert.ToInt32(draft.Value["maxTokens"]) == 8192, "new model defaults changed");
            draft.Begin(state, "test");
            draft.Value["id"] = "INVALID ID";
            Check(!draft.Valid, "invalid identifiers must be rejected");
            using (var connection = new Connection())
            {
                connection.Client = new HttpClient();
                connection.Dispose();
                connection.Dispose();
            }
            var handler = new DelayedHandler();
            using (var connection = new Connection())
            {
                connection.Client = new HttpClient(handler) { BaseAddress = new Uri("http://127.0.0.1") };
                var pending = connection.Call("/api/state", null);
                connection.Dispose();
                handler.Response.SetResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
                {
                    Content = new StringContent("{}")
                });
                bool rejected = false;
                try
                {
                    pending.GetAwaiter().GetResult();
                }
                catch (ObjectDisposedException) { rejected = true; }
                catch (OperationCanceledException) { rejected = true; }
                Check(rejected, "responses after disposal must not reach the form");
            }
            Console.WriteLine("Native draft isolation, validation and repeated disposal passed");
        }
    }
}
