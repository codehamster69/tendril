import { validateRestore } from './restore-validator';
import type { RestoreRequest, RestoreReply } from './restore-validation';

const channel = new MessageChannel();
const yieldTask = (): Promise<void> => new Promise(resolve => {
  channel.port1.onmessage = () => resolve();
  channel.port2.postMessage(null);
});
self.onmessage = async (event: MessageEvent<RestoreRequest>) => {
  const { id, input } = event.data;
  const post = (reply: RestoreReply): void => self.postMessage(reply);
  try {
    await validateRestore(input, (done, total) => post({ id, type: 'progress', done, total }), yieldTask);
    post({ id, type: 'ready' });
  } catch (error) {
    post({ id, type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
