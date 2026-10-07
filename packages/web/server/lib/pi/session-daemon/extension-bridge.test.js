import { describe, expect, it } from 'vitest';
import { createExtensionBridge } from './extension-bridge.js';

const fixture = () => {
  const events = [];
  const bridge = createExtensionBridge({
    publish: (event, payload, sessionId) => events.push({event, payload, sessionId}),
    resolveDirectory: async value => value,
    getDefaultDirectory: () => '/fixture',
    findRuntimeBySessionId: () => undefined,
    protocolError: (code, message) => Object.assign(new Error(message), {code}),
  });
  const ui = sessionId => bridge.buildExtensionBindings({sessionId}).uiContext;
  return {bridge,events,ui};
};

describe('extension approval lifecycle', () => {
  it('does not publish or strand pre-aborted dialogs', async () => {
    const f=fixture(); const abort=new AbortController(); abort.abort();
    expect(await f.ui('A').select('Approve?', ['Allow once','Denied'], {signal:abort.signal})).toBeUndefined();
    expect(f.events).toEqual([]); expect(f.bridge.getSnapshotState('A').dialogs).toBeUndefined();
  });
  it('binds concurrent answers to session/request and rejects unoffered choices without settling', async () => {
    const f=fixture(); const a=f.ui('A').select('A?', ['Allow once','Denied']); const b=f.ui('B').select('B?', ['Allow once','Denied']);
    const [first,second]=f.events.filter(event=>event.event==='extension.dialog');
    await expect(f.bridge.resolveExtensionDialog({requestId:first.payload.requestId,sessionId:'B',value:'Allow once'})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
    await expect(f.bridge.resolveExtensionDialog({requestId:first.payload.requestId,sessionId:'A',value:'forged'})).rejects.toMatchObject({code:'INVALID_ARGUMENT'});
    expect(f.bridge.getSnapshotState('A').dialogs[0].requestId).toBe(first.payload.requestId);
    await f.bridge.resolveExtensionDialog({requestId:second.payload.requestId,sessionId:'B',cancelled:true,confirmed:true});
    expect(await b).toBeUndefined(); expect(f.bridge.getSnapshotState('A').dialogs).toHaveLength(1);
    await f.bridge.resolveExtensionDialog({requestId:first.payload.requestId,sessionId:'A',value:'Allow once'});
    expect(await a).toBe('Allow once');
    expect(await f.bridge.resolveExtensionDialog({requestId:first.payload.requestId,sessionId:'A',value:'Allow once'})).toEqual({resolved:false});
  });
  it('preserves live state for reconnect and removes it on abort, timeout, or close', async () => {
    const f=fixture(); const ui=f.ui('A'); const abort=new AbortController();
    ui.setStatus('permissions','permissions/v1 mode=auto readOnly=off');
    const pending=ui.select('Reconnect?', ['Allow once','Denied'], {signal:abort.signal});
    expect(f.bridge.getSnapshotState('A').statuses[0].text).toContain('mode=auto');
    expect(f.bridge.getSnapshotState('A').dialogs).toHaveLength(1);
    abort.abort(); expect(await pending).toBeUndefined();
    expect(f.bridge.getSnapshotState('A').dialogs).toBeUndefined();
    expect(await ui.confirm('Timeout?', 'Approve?', {timeout:5})).toBe(false);
    const closing=ui.select('Close?', ['Allow once','Denied']); f.bridge.clearExtensionState('A');
    expect(await closing).toBeUndefined(); expect(f.bridge.getSnapshotState('A')).toEqual({});
    expect(f.events.filter(event=>event.event==='extension.dialog.dismiss').map(event=>event.payload.reason)).toEqual(['aborted','timeout','session-closed']);
  });
});
