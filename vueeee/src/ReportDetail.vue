<script setup>
defineProps({ report: { type: Object, required: true } });
defineEmits(['back']);
</script>

<template>
  <section class="list-section">
    <button class="back-button" @click="$emit('back')">← 返回候选人报告</button>
    <article class="detail-panel report-detail-panel">
      <p class="eyebrow">CANDIDATE REPORT</p>
      <h1>{{ report.cand || '候选人' }}</h1>
      <p class="muted">{{ report.jobName }} · {{ report.at ? new Date(report.at).toLocaleString('zh-CN') : '' }}</p>
      <div v-if="report.recommend" class="prep-summary"><strong>AI 建议：</strong>{{ report.recommend.text }}</div>
      <div class="detail-stats"><div><strong>{{ report.round1?.verdict || '—' }}</strong><span>第一轮</span></div><div><strong>{{ report.eval?.verdict || '—' }}</strong><span>第二轮评估</span></div><div><strong>{{ report.practice?.hrScore ?? report.practice?.autoScore ?? '—' }}</strong><span>实操得分</span></div></div>
      <h2>面试问答</h2>
      <div v-for="(item, index) in report.answers || report.round1?.answers || []" :key="index" class="qa-block"><strong>{{ item.question || item.q || `问题 ${index + 1}` }}</strong><p>{{ item.answer || item.a || '暂无回答' }}</p></div>
      <p v-if="!(report.answers || report.round1?.answers || []).length" class="empty-state">报告详情已加载。当前记录没有可展示的问答明细。</p>
    </article>
  </section>
</template>
