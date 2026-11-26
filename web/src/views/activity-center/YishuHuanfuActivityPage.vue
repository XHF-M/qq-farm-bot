<script setup lang="ts">
/**
 * 以薯换福详情页壳。
 *
 * 面板本身自带头图、返回按钮与三个 Tab（红薯小铺 / 兑换商店 / 好友比价），
 * 这里只负责套上活动中心的统一 Shell 与滚动容器，保持与其它活动页一致的版心。
 */
import ActivityShell from '@/components/activity/ActivityShell.vue'
import YishuHuanfuActivityPanel from '@/components/activity/YishuHuanfuActivityPanel.vue'

const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <ActivityShell theme="day">
    <div class="activity-center">
      <main class="activity-content yishu-huanfu-content">
        <YishuHuanfuActivityPanel @back="emit('back')" />
      </main>
    </div>
  </ActivityShell>
</template>

<style scoped>
.activity-center {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.yishu-huanfu-content {
  position: absolute;
  inset: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 16px;
  border: 0;
  background: transparent;
  overscroll-behavior: contain;
}
</style>
