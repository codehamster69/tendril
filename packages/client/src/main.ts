import './style.css';
import { createEditor } from './editor';
import { FarmView } from './farm-view';
import { GameLoop } from './game-loop';
import { MockSim } from './mock-sim';

const editor = createEditor(document.getElementById('editor')!);
const view = new FarmView(document.getElementById('farm-canvas') as HTMLCanvasElement);
new GameLoop(new MockSim(), view, editor);
