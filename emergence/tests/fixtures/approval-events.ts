/** Observe native approval identities; unresolved tool calls are not approval requests. */
export function approvalEvents(journal: string) {
  const calls = new Map<string, { callId: string; name: string; arguments: string }>();
  const pending = new Map<string, { id: string; callId: string; toolName: string; time: number }>();
  const decisions = new Map<string, string>();
  for (const line of journal.split('\n').slice(0, -1).filter(Boolean)) {
    const event = JSON.parse(line);
    const data = event.data;
    if (event.type === 'tool/call') calls.set(data.callId, data);
    if (event.type === 'approval/asked') pending.set(data.id, { ...data, time: event.time });
    if (event.type === 'approval/decided') {
      pending.delete(data.id);
      decisions.set(data.id, data.outcome);
    }
  }
  return {
    pending: [...pending.values()].map((request) => {
      const call = calls.get(request.callId);
      if (!call || call.name !== request.toolName) throw new Error('Approval has no matching tool call');
      return { ...request, call };
    }),
    decisions,
  };
}
