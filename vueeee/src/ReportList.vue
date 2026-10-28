<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ reports: { type: Array, default: () => [] }, job: { type: Object, default: null } });
const emit = defineEmits(['open', 'back']);
const filter = ref('all');
const page = ref(0);
const pageSize = 15;
const stages = [
  ['all', '全部'], ['pending', '待决定'], ['interviewing', '二轮进行中'], ['practice', '第三关·实操中'],
  ['evaluated', '已评估'], ['offer', '已发 Offer'], ['signing', '待签约'], ['signed', '已签约'],
];
const filtered = computed(() => props.reports.filter((report) => filter.value === 'all' || report.stage === filter.value));
const maxPage = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const visible = computed(() => filtered.value.slice(page.value * pageSize, (page.value + 1) * pageSize));
watch(filter, () => { page.value = 0; });
const stageName = (stage) => stages.find(([key]) => key === stage)?.[1] || '未知阶段';
</script>

<template>
  <section class="list-section">
    <div class="section-heading"><div><p class="eyebrow">CANDIDATE REPORTS</p><h1>{{ job ? `候选人报告 · ${job.name}` : '候选人报告' }}</h1></div><button class="secondary-button" @click="emit('back')">返回岗位</button></div>
    <div class="filter-strip">
      <button v-for="[key, label] in stages" :key="key" :class="{ selected: filter === key }" @click="filter = key">{{ label }} <span>{{ key === 'all' ? reports.length : reports.filter((report) => report.stage === key).length }}</span></button>
    </div>
    <div v-if="!visible.length" class="empty-state">暂无此阶段的候选人报告。</div>
    <div v-else class="report-list">
      <article v-for="report in visible" :key="report.id" class="report-row">
        <div class="avatar">{{ (report.cand || '?').slice(0, 1) }}</div>
        <div class="report-main"><div class="report-heading"><strong>{{ report.cand || '候选人' }}</strong><span class="stage-label">{{ stageName(report.stage) }}</span><span v-if="report.round1" class="muted">一轮{{ report.round1.verdict }}</span><span v-if="report.eval" class="muted">二轮{{ report.eval.verdict }}</span></div><p class="muted">{{ report.at ? new Date(report.at).toLocaleString('zh-CN') : '' }}<template v-if="report.recommend"> · AI：{{ report.recommend.text }}</template></p></div>
        <button class="secondary-button" @click="emit('open', report)">查看报告</button>
      </article>
    </div>
    <footer v-if="maxPage > 1" class="pagination"><button class="secondary-button" :disabled="page === 0" @click="page--">上一页</button><span>第 {{ page + 1 }} / {{ maxPage }} 页</span><button class="secondary-button" :disabled="page >= maxPage - 1" @click="page++">下一页</button></footer>
  </section>
</template>
