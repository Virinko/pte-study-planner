<script setup lang="ts">
import { FileDown, X } from '@lucide/vue';
import { onBeforeUnmount, ref } from 'vue';
import { CHECK_IN_HEIGHT, CHECK_IN_WIDTH, renderStudyCheckIn, type StudyCheckInReport } from './studyCheckInImage';

const dialog = ref<HTMLDialogElement | null>(null);
const loading = ref(false);
const error = ref('');
const images = ref<{ url: string; filename: string }[]>([]);
let generation = 0;

function releaseImages() {
  generation++;
  for (const image of images.value) URL.revokeObjectURL(image.url);
  images.value = [];
}

async function open(report: StudyCheckInReport) {
  if (!dialog.value || dialog.value.open) return;
  releaseImages();
  const request = generation;
  loading.value = true;
  error.value = '';
  dialog.value.showModal();

  try {
    const blobs = await renderStudyCheckIn(report);
    if (request !== generation || !dialog.value?.open) return;
    images.value = blobs.map((blob, index) => ({
      url: URL.createObjectURL(blob),
      filename: `PTE-打卡-${report.date}${blobs.length > 1 ? `-${index + 1}` : ''}.png`,
    }));
  } catch {
    if (request === generation) error.value = '打卡图生成失败，请关闭后重试。';
  } finally {
    if (request === generation) loading.value = false;
  }
}

onBeforeUnmount(releaseImages);
defineExpose({ open });
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="check-in-dialog" aria-labelledby="check-in-title" @close="releaseImages">
      <header class="check-in-header">
        <h2 id="check-in-title">打卡图预览</h2>
        <form method="dialog">
          <button type="submit" class="check-in-close" aria-label="关闭预览" autofocus>
            <X :size="19" aria-hidden="true" />
          </button>
        </form>
      </header>
      <div class="check-in-body">
        <p v-if="loading" role="status">正在生成打卡图…</p>
        <p v-else-if="error" role="alert">{{ error }}</p>
        <figure v-for="(image, index) in images" :key="image.url" class="check-in-preview">
          <img :src="image.url" :width="CHECK_IN_WIDTH" :height="CHECK_IN_HEIGHT"
            :alt="images.length > 1 ? `PTE 学习打卡图，第 ${index + 1} 张` : 'PTE 学习打卡图'">
          <figcaption>
            <a :href="image.url" :download="image.filename">
              <FileDown :size="17" aria-hidden="true" />
              {{ images.length > 1 ? `下载第 ${index + 1} 张 PNG` : '下载 PNG' }}
            </a>
          </figcaption>
        </figure>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.check-in-dialog {
  box-sizing: border-box;
  width: min(560px, calc(100vw - 28px));
  max-height: calc(100vh - 28px);
  max-height: calc(100dvh - 28px);
  padding: 0;
  border: 1px solid #e3dfef;
  border-radius: 16px;
  color: #262d3d;
  background: #fff;
  box-shadow: 0 16px 50px #262d3d26;
}

.check-in-dialog::backdrop { background: #262d3d66; }
.check-in-header {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid #ece8f4;
  background: #fff;
}
.check-in-header h2 { margin: 0; font-size: 18px; font-weight: 500; }
.check-in-close {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid #e8e3f1;
  border-radius: 8px;
  color: #57518e;
  background: #f5f2fa;
  cursor: pointer;
}
.check-in-body { padding: 16px 18px; }
.check-in-body p { margin: 0; font-weight: 400; }
.check-in-preview { margin: 0 auto; width: min(100%, 410px, max(240px, calc((100dvh - 170px) * .75))); }
.check-in-preview + .check-in-preview { margin-top: 24px; }
.check-in-preview img {
  display: block;
  width: 100%;
  height: auto;
  border: 1px solid #e9e4f5;
  border-radius: 10px;
}
.check-in-preview figcaption { display: flex; justify-content: center; margin-top: 12px; }
.check-in-preview a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: #f0ecfb;
  color: #57518e;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
}
.check-in-preview a:hover { background: #e8e2f8; }
</style>
