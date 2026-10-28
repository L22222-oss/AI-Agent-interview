<script setup>
import { computed, ref } from 'vue';
import { api } from './api.js';

const props = defineProps({ job: { type: Object, required: true }, reports: { type: Array, default: () => [] } });
const emit = defineEmits(['back', 'reports', 'delete', 'resume']);
const tab = ref('entry');
const prep = ref(null);
const busy = ref(false);
const error = ref('');
const interviewLink = computed(() => `${location.origin}/?job=${encodeURIComponent(props.job.id)}&name=${encodeURIComponent(props.job.name)}`);
const portalLink = computed(() => `${location.origin}/?portal=${encodeURIComponent(props.job.id)}`);
const reports = computed(() => props.reports.filter((item) => item.jobId === props.job.id));
const evaluated = computed(() => reports.value.filter((item) => ['evaluated', 'offer', 'signing', 'signed'].includes(item.stage)).length);

async function loadPrep() {
  tab.value = 'ai';
  busy.value = true;
  error.value = '';
  try { const result = await api(`/api/jobs/${encodeURIComponent(props.job.id)}/ai-prep`); prep.value = result.prep; }
  catch (err) { error.value = err.message; }
  finally { busy.value = false; }
}
async function generatePrep() {
  busy.value = true;
  error.value = '';
  try { const result = await api(`/api/jobs/${encodeURIComponent(props.job.id)}/ai-prep`, { method: 'POST', body: {} }); prep.value = result; }
  catch (err) { error.value = err.message; }
  finally { busy.value = false; }
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); window.dispatchEvent(new CustomEvent('app-toast', { detail: '链接已复制' })); }
  catch { error.value = '复制失败，请手动选择链接复制'; }
}
</script>

<template>
  <section class="detail-page">
    <button class="back-button" @click="emit('back')">← 返回岗位</button>
    <div class="detail-panel">
      <header class="detail-heading"><div><p class="eyebrow">JOB WORKSPACE</p><h1>{{ job.name }}</h1></div><span class="status-pill" :class="job.status">{{ job.status === 'published' ? '已发布' : '草稿' }}</span></header>
      <div class="detail-stats"><div><strong>{{ job.candidates || 0 }}</strong><span>已申请入口</span></div><div><strong>{{ reports.length }}</strong><span>已生成报告</span></div><div><strong>{{ evaluated }}</strong><span>已完成评估</span></div></div>
      <div class="detail-tabs"><button :class="{ selected: tab === 'entry' }" @click="tab = 'entry'">面试入口</button><button :class="{ selected: tab === 'candidate' }" @click="tab = 'candidate'">候选人</button><button :class="{ selected: tab === 'practice' }" @click="tab = 'practice'">第三关实操</button><button :class="{ selected: tab === 'ai' }" @click="loadPrep">AI 准备</button></div>

      <div v-if="tab === 'entry'" class="detail-content">
        <h2>候选人面试入口</h2><p class="muted">发给候选人的一对一链接：AI 依据简历出题并逐题追问。</p><div class="link-box">{{ interviewLink }}</div><div class="button-row"><button class="secondary-button" @click="copy(interviewLink)">复制面试链接</button><a class="primary-button" :href="interviewLink" target="_blank" rel="noreferrer">打开候选人入口</a></div>
        <h2 class="subheading">自助查询入口</h2><p class="muted">候选人凭姓名和认证码查询进度并进入下一环节。</p><div class="link-box">{{ portalLink }}</div><div class="button-row"><button class="secondary-button" @click="copy(portalLink)">复制自助入口</button><a class="primary-button" :href="portalLink" target="_blank" rel="noreferrer">打开自助入口</a></div>
      </div>
      <div v-else-if="tab === 'candidate'" class="detail-content"><h2>候选人</h2><p class="muted">此岗位已有 {{ reports.length }} 份候选人报告。</p><button class="primary-button" @click="emit('reports', job)">查看候选人报告</button><button class="secondary-button spaced-button" @click="emit('resume', job)">上传简历并生成专属问题</button></div>
      <div v-else-if="tab === 'practice'" class="detail-content"><h2>第三关 · 实操交付</h2><p class="muted">完成二轮的候选人可提交作品网址，报告详情中可查看并审核。</p><div v-if="!reports.some((item) => item.practice)" class="empty-state">暂无实操提交</div><div v-for="item in reports.filter((r) => r.practice)" :key="item.id" class="candidate-mini"><strong>{{ item.cand }}</strong><span>{{ item.practice.url || '待提交' }}</span><span class="muted">{{ item.practice.hrScore != null ? `已确认 ${item.practice.hrScore} 分` : `预评 ${item.practice.autoScore ?? '待评估'} 分` }}</span></div></div>
      <div v-else class="detail-content"><h2>AI 面试准备</h2><p class="muted">预计 {{ job.duration || 35 }} 分钟 · 两轮共 {{ (job.round1Count || 6) + (job.round2Count || 6) }} 题</p><p v-if="busy" class="muted">正在读取 AI 配置与岗位方案…</p><p v-if="error" class="form-error">{{ error }}</p><template v-if="prep"><p v-if="prep.summary" class="prep-summary">{{ prep.summary }}</p><div v-for="(items, key) in { focus: prep.focus, round1: prep.round1, round2: prep.round2 }" :key="key"><h3>{{ { focus: '岗位考察重点', round1: '第一轮问题', round2: '第二轮问题' }[key] }}</h3><ul><li v-for="(item, index) in items || []" :key="index">{{ typeof item === 'string' ? item : item.label || item.question }}</li></ul></div></template><div class="button-row"><button class="primary-button" :disabled="busy" @click="generatePrep">生成岗位 AI 面试方案</button><button class="secondary-button" @click="emit('resume', job)">上传简历</button></div></div>

      <footer class="detail-actions"><button class="primary-button" @click="emit('reports', job)">查看候选人报告</button><button class="danger-button" @click="emit('delete', job)">删除岗位</button></footer>
    </div>
  </section>
</template>
