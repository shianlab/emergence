// Native Windows Forms controls only. No HTML, WebView, browser process or UI dependencies.
// Uses the same authenticated configuration service as the TUI, preserving its validation and DPAPI logic.

namespace Emergence.ModelConfiguration
{
    sealed class Choice
    {
        internal string Id, Label;
        internal Choice(string id, string label)
        {
            Id = id;
            Label = label;
        }
        public override string ToString()
        {
            return Label;
        }
    }

}
