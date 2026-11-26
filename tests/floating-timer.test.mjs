import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const { ref, shallowRef, computed, watch, reactive, nextTick } = require('vue');
const source = readFileSync(new URL('../src/FloatingTimer.vue', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/floatingTimer.css', import.meta.url), 'utf8');
const { descriptor } = parse(source);
const script = compileScript(descriptor, { id: 'floating-timer-test' });
const code = ts.transpileModule(script.content, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function fixture({ failStyles = false, rejectOpen = false, rejectFocus = false } = {}) {
  const calls = { resize: 0, closed: 0, intervals: 0, cleared: 0, focused: 0, openerFocused: 0, styles: [], events: [] };
  let onHide;
  const popup = {
    closed: false,
    document: {
      body: {}, createElement: () => ({}),
      head: { append(style) { if (failStyles) throw new Error('style error'); calls.styles.push(style); } },
    },
    // Chrome rejects programmatic resizing after requestWindow consumed activation.
    resizeTo() { calls.resize++; throw new DOMException('Requires user activation', 'NotAllowedError'); },
    addEventListener(name, callback) { if (name === 'pagehide') onHide = callback; },
    setInterval() { calls.intervals++; return 1; },
    clearInterval() { calls.cleared++; },
    focus() { calls.focused++; },
    close() { this.closed = true; calls.closed++; onHide?.(); },
  };
  const exports = {};
  const context = vm.createContext({
    exports,
    window: {
      isSecureContext: true,
      focus() {
        calls.openerFocused++;
        if (rejectFocus) throw new DOMException('Focus rejected', 'NotAllowedError');
      },
      documentPictureInPicture: { async requestWindow(options) {
        calls.options = options;
        if (rejectOpen) throw new Error('PiP unavailable');
        popup.closed = false;
        return popup;
      } },
    },
    require(name) {
      if (name === 'vue') return { ref, shallowRef, computed, watch, defineComponent: (component) => component, onBeforeUnmount() {} };
      if (name === './floatingTimer.css?inline') return { default: styles };
      if (name === '@lucide/vue') return {};
      throw new Error(`Unexpected module: ${name}`);
    },
  });
  vm.runInContext(code, context);
  let api;
  const props = reactive({ active: true, name: 'RS', pending: false, saving: false });
  const state = exports.default.setup(props, { expose(value) { api = value; }, emit(event) { calls.events.push(event); } });
  return { api, state, calls, popup, props };
}

test('compact PiP attaches content and styles without requiring a second user gesture', async () => {
  const { api, state, calls, popup } = fixture();
  await api.open();
  assert.equal(api.openError.value, '');
  assert.equal(state.target.value, popup.document.body);
  assert.equal(api.isOpen.value, true);
  assert.equal(calls.resize, 0);
  assert.equal(calls.options.width, 240);
  assert.equal(calls.options.height, 106);
  assert.equal(calls.styles[0].textContent, styles);
  assert.equal(calls.intervals, 1);
  await api.open();
  assert.equal(calls.focused, 1);
  assert.equal(calls.intervals, 1);
  popup.close();
  assert.equal(api.isOpen.value, false);
  assert.equal(calls.cleared, 1);
});

test('initialization errors close the empty window and allow another attempt', async () => {
  const { api, state, calls } = fixture({ failStyles: true });
  await api.open();
  assert.equal(calls.closed, 1);
  assert.equal(state.target.value, null);
  assert.equal(api.opening.value, false);
  assert.ok(api.openError.value);
  await api.open();
  assert.equal(calls.closed, 2);
});

test('rejected PiP requests leave no window or timer', async () => {
  const { api, state, calls } = fixture({ rejectOpen: true });
  await api.open();
  assert.equal(state.target.value, null);
  assert.equal(api.opening.value, false);
  assert.equal(calls.intervals, 0);
  assert.ok(api.openError.value);
});

test('cancel requires confirmation in the floating window and respects pending saves', async () => {
  const { api, state, calls, props } = fixture();
  await api.open();
  calls.events.length = 0;
  state.cancel();
  assert.equal(state.confirmingCancel.value, true);
  assert.deepEqual(calls.events, []);
  assert.equal(calls.closed, 0);
  assert.equal(calls.openerFocused, 0);
  state.cancel();
  assert.deepEqual(calls.events, ['cancel']);
  assert.equal(calls.openerFocused, 1);
  assert.equal(calls.closed, 1);
  assert.equal(calls.cleared, 1);
  assert.equal(api.isOpen.value, false);

  state.cancel();
  state.toggle();
  assert.equal(state.confirmingCancel.value, false);
  state.cancel();
  state.save();
  assert.equal(state.confirmingCancel.value, false);

  for (const blocked of [{ saving: true }, { pending: true }, { active: false }]) {
    Object.assign(props, { active: true, pending: false, saving: false }, blocked);
    await nextTick();
    const before = calls.events.length;
    state.cancel();
    state.cancel();
    assert.equal(calls.events.length, before);
    assert.equal(state.confirmingCancel.value, false);
  }
});

test('confirmed cancel closes the popup even if browser focus is rejected', async () => {
  const { api, state, calls } = fixture({ rejectFocus: true });
  await api.open();
  state.cancel();
  assert.doesNotThrow(() => state.cancel());
  assert.equal(calls.closed, 1);
  assert.equal(api.isOpen.value, false);
});
