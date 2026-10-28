<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ jobs: { type: Array, default: () => [] }, reports: { type: Array, default: () => [] }, createJob: { type: Function, required: true } });
const emit = defineEmits(['open', 'delete']);
const query = ref('');
const status = ref('all');
const page = ref(0);
const pageSize = 8;
const creating = ref(false);
const name = ref('');
const jd = ref('');
const headcount = ref(1);
const publishStatus = ref('published');
const error = ref('');
const filtered = computed(() => props.jobs.filter((job) =>
  (status.value === 'all' || job.status === status.value) && job.name.toLowerCase().includes(query.value.trim().toLowerCase())
));
watch(() => filtered.value.length, resetPage);
const maxPage = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)));
const pageJobs = computed(() => filtered.value.slice(page.value * pageSize, (page.value + 1) * pageSize));
const candidateTotal = computed(() => props.jobs.reduce((sum, job) => sum + (Number(job.candidates) || 0), 0));
const publishedTotal = computed(() => props.jobs.filter((job) => job.status === 'published').length);

function funnel(job) {
  const counts = { pending: 0, interviewing: 0, practice: 0, evaluated: 0, offer: 0, signing: 0, signed: 0 };
  props.reports.filter((report) => report.jobId === job.id).forEach((report) => {
    if (counts[report.stage] !== undefined) counts[report.stage] += 1;
  });
  return counts;
}

function resetPage() { page.value = 0; }
async function submitJob() {
  error.value = '';
  if (!name.value.trim()) { error.value = '请填写岗位名称'; return; }
  try {
    await props.createJob({ name: name.value.trim(), jd: jd.value, headcount: Math.max(1, Number(headcount.value) || 1), status: publishStatus.value });
    name.value = '';
    jd.value = '';
    headcount.value = 1;
    creating.value = false;
  } catch (err) {
    error.value = err.message;
  }
}
</script>

<template>
  <section class="workspace-page">
    <header class="workspace-heading">
      <div>
        <p class="eyebrow">PERSONAL WORKSPACE</p>
        <h1>岗位工作台</h1>
        <p class="muted">共 {{ jobs.length }} 个岗位 · 共 {{ candidateTotal }} 位候选人</p>
      </div>
      <div class="summary-stats">
        <div class="summary-stat"><strong>{{ publishedTotal }}</strong><span>可访问岗位</span></div>
        <div class="summary-stat"><strong>{{ candidateTotal }}</strong><span>位候选人</span></div>
      </div>
    </header>

    <section class="list-section">
      <div class="section-heading">
        <h2>岗位与面试</h2>
        <button class="primary-button" @click="creating = true">＋ 创建 AI 面试</button>
      </div>
      <div class="list-toolbar">
        <input v-model="query" class="search-input" placeholder="搜索岗位名称" @input="resetPage" />
        <div class="segmented-control" aria-label="岗位状态筛选">
          <button v-for="item in [['all', '全部'], ['published', '已发布'], ['draft', '草稿']]" :key="item[0]" :class="{ selected: status === item[0] }" @click="status = item[0]; resetPage()">{{ item[1] }}</button>
        </div>
      </div>

      <div v-if="!pageJobs.length" class="empty-state">没有匹配的岗位。调整搜索条件或创建岗位。</div>
      <div v-else class="job-list">
        <article v-for="job in pageJobs" :key="job.id" class="job-row" tabindex="0" @click="emit('open', job)" @keydown.enter="emit('open', job)">
          <div class="job-row-main">
            <span class="status-dot" :class="job.status"></span>
            <div class="job-title-block">
              <h3>{{ job.name }}</h3>
              <p class="muted">{{ job.status === 'published' ? '已发布' : '草稿' }} · 招 {{ job.headcount || 1 }} 人 · {{ job.candidates || 0 }} 位候选人 · 更新于 {{ (job.updatedAt || job.date || '').slice(0, 10) }}</p>
            </div>
            <button class="icon-button delete-button" title="删除岗位" aria-label="删除岗位" @click.stop="emit('delete', job)">×</button>
          </div>
          <div class="funnel-row">
            <span>待决定 {{ funnel(job).pending }}</span><span>二轮 {{ funnel(job).interviewing }}</span><span>实操 {{ funnel(job).practice }}</span><span>已评估 {{ funnel(job).evaluated }}</span><span>Offer {{ funnel(job).offer }}</span><span>签约 {{ funnel(job).signing + funnel(job).signed }}</span>
          </div>
        </article>
      </div>

      <footer v-if="maxPage > 1" class="pagination">
        <button class="secondary-button" :disabled="page === 0" @click="page--">上一页</button>
        <span>第 {{ page + 1 }} / {{ maxPage }} 页</span>
        <button class="secondary-button" :disabled="page >= maxPage - 1" @click="page++">下一页</button>
      </footer>
    </section>

    <div v-if="creating" class="modal-backdrop" @click.self="creating = false">
      <form class="dialog" @submit.prevent="submitJob">
        <div class="section-heading"><h2>创建 AI 面试</h2><button type="button" class="icon-button" aria-label="关闭" @click="creating = false">×</button></div>
        <label class="field-label" for="job-name">岗位名称</label>
        <input id="job-name" v-model="name" required placeholder="例如：后端实习生" />
        <div class="form-grid">
          <div><label class="field-label" for="headcount">招聘人数</label><input id="headcount" v-model.number="headcount" type="number" min="1" /></div>
          <div><label class="field-label" for="job-status">状态</label><select id="job-status" v-model="publishStatus"><option value="published">已发布</option><option value="draft">草稿</option></select></div>
        </div>
        <label class="field-label" for="job-jd">岗位描述</label>
        <textarea id="job-jd" v-model="jd" rows="5" placeholder="职责、要求、加分项（可选）"></textarea>
        <p v-if="error" class="form-error">{{ error }}</p>
        <div class="dialog-actions"><button type="button" class="secondary-button" @click="creating = false">取消</button><button class="primary-button" type="submit">创建面试</button></div>
      </form>
    </div>
  </section>
</template>
