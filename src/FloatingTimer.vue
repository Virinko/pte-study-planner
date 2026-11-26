<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { Clock, Pause, Play, Save, Trash2 } from '@lucide/vue';
import floatingStyles from './floatingTimer.css?inline';

const props = defineProps<{
  name: string;
  seconds: string;
  paused: boolean;
  active: boolean;
  pending: boolean;
  saving: boolean;
  message: string;
}>();
const emit = defineEmits<{ tick: []; toggle: []; save: []; cancel: [] }>();
const confirmingCancel = ref(false);
watch(() => [props.active, props.name, props.pending, props.saving], () => { confirmingCancel.value = false; });

function toggle() {
  confirmingCancel.value = false;
  emit('toggle');
}

function save() {
  confirmingCancel.value = false;
  emit('save');
}

function cancel() {
  if (!props.active || props.saving || props.pending) return;
  if (!confirmingCancel.value) {
    confirmingCancel.value = true;
    return;
  }
  confirmingCancel.value = false;
  emit('cancel');
  try {
    // Keep the focus request inside the confirming click's user activation.
    window.focus();
  } catch {
    // Closing the popup must still succeed if Chrome rejects the focus request.
  }
  pipWindow?.close();
}
type PipWindow = Window & typeof globalThis;
const pip = (window as Window & {
  documentPictureInPicture?: { requestWindow: (options: { width: number; height: number; preferInitialWindowPlacement: boolean }) => Promise<PipWindow> };
}).documentPictureInPicture;
const supported = Boolean(pip) && window.isSecureContext;
const target = shallowRef<HTMLElement | null>(null);
const opening = ref(false);
const openError = ref('');
const isOpen = computed(() => Boolean(target.value));
let pipWindow: PipWindow | null = null;
let interval: number | undefined;

function release() {
  confirmingCancel.value = false;
  if (interval !== undefined) pipWindow?.clearInterval(interval);
  interval = undefined;
  target.value = null;
  pipWindow = null;
}

async function open() {
  if (!pip || opening.value) return;
  if (pipWindow && !pipWindow.closed) {
    pipWindow.focus();
    return;
  }
  opening.value = true;
  openError.value = '';
  try {
    // requestWindow sizes the content; reserve space for Chrome's title bar.
    // Opening consumes user activation, so resizeTo here would throw before mount.
    pipWindow = await pip.requestWindow({ width: 240, height: 106, preferInitialWindowPlacement: false });
    pipWindow.document.title = 'PTE 悬浮计时';
    const style = pipWindow.document.createElement('style');
    style.textContent = floatingStyles;
    pipWindow.document.head.append(style);
    pipWindow.addEventListener('pagehide', release, { once: true });
    target.value = pipWindow.document.body;
    // Run the display clock in the visible window when the planner tab is hidden.
    interval = pipWindow.setInterval(() => emit('tick'), 250);
    emit('tick');
  } catch {
    pipWindow?.close();
    release();
    openError.value = '悬浮计时窗未能加载，请重试打开。';
  } finally {
    opening.value = false;
  }
}

onBeforeUnmount(() => {
  pipWindow?.close();
  release();
});
defineExpose({ open, supported, isOpen, opening, openError });
</script>

<template>
  <Teleport v-if="target" :to="target">
    <main class="floating-timer">
      <header><span class="floating-brand"><Clock :size="10" />PTE · 悬浮计时</span><span class="floating-state" :class="{ paused }">{{ saving ? '保存中' : !active ? '已结束' : pending ? '待保存' : paused ? '已暂停' : '计时中' }}</span></header>
      <h1 :title="name">{{ name || '本次练习' }}</h1>
      <div class="floating-time" aria-label="本次用时">{{ seconds }}</div>
      <div v-if="active" class="floating-actions">
        <button type="button" :disabled="saving || pending" @click="toggle"><Play v-if="paused" :size="13" /><Pause v-else :size="13" />{{ paused ? '继续' : '暂停' }}</button>
        <button type="button" class="floating-save" :disabled="saving" @click="save"><Save :size="13" />{{ saving ? '保存中' : pending ? '重试' : '保存' }}</button>
        <button type="button" class="floating-cancel" :class="{ 'is-confirming': confirmingCancel }" :disabled="saving || pending" @click="cancel"><Trash2 :size="13" />{{ confirmingCancel ? '确认取消' : '取消' }}</button>
      </div>
      <p v-if="message" class="floating-message" role="status">{{ message }}</p>
    </main>
  </Teleport>
</template>
