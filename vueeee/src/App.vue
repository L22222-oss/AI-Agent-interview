<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from './api.js';
import JobDetail from './JobDetail.vue';
import JobWorkspace from './JobWorkspace.vue';
import LegacyBridge from './LegacyBridge.vue';
import LoginView from './LoginView.vue';
import ReportDetail from './ReportDetail.vue';
import ReportList from './ReportList.vue';

const user = ref(null);
const jobs = ref([]);
const reports = ref([]);
const selectedJob = ref(null);
const selectedReport = ref(null);
const view = ref('jobs');
const loading = ref(true);
const toast = ref('');
const toastTimer = ref(null);
const params = new URLSearchParams(location.search);
const legacyMode = ref(params.has('legacy') || params.has('job') || params.has('offer') || params.has('portal'));
const selectedJobReports = computed(() => selectedJob.value ? reports.value.filter((report) => report.jobId === selectedJob.value.id) : reports.value);

function notify(message) {
  toast.value = message;
  clearTimeout(toastTimer.value);
  toastTimer.value = setTimeout(() => { toast.value = ''; }, 2600);
}
function onToast(event) { notify(event.detail); }
function onSessionExpired() { user.value = null; view.value = 'jobs'; }

async function loadWorkspace() {
  const [jobRows, reportRows] = await Promise.all([api('/api/jobs'), api('/api/reports')]);
  jobs.value = jobRows;
  reports.value = reportRows;
  if (selectedJob.value) selectedJob.value = jobs.value.find((job) => job.id === selectedJob.value.id) || null;
}
async function restoreSession() {
  loading.value = true;
  try {
    user.value = await api('/api/auth/session');
    if (user.value) await loadWorkspace();
  } catch {
    user.value = null;
  } finally {
    loading.value = false;
  }
}
async function authenticated(account) {
  user.value = account;
  try { await loadWorkspace(); }
  catch (error) { notify(error.message); }
}
async function createJob(payload) {
  if (jobs.value.some((job) => job.name.toLowerCase() === payload.name.toLowerCase())) throw new Error('已存在同名岗位，请更换名称');
  const job = await api('/api/jobs', { method: 'POST', body: payload });
  jobs.value = [job, ...jobs.value];
  notify(payload.status === 'draft' ? '岗位已保存为草稿' : '岗位创建成功');
}
async function deleteJob(job) {
  if (!window.confirm(`确定删除岗位「${job.name}」？候选人与报告将保留。`)) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    jobs.value = jobs.value.filter((item) => item.id !== job.id);
    selectedJob.value = null;
    view.value = 'jobs';
    notify('岗位已删除');
  } catch (error) { notify(error.message); }
}
async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); }
  finally { user.value = null; jobs.value = []; reports.value = []; view.value = 'jobs'; }
}
async function openReport(report) {
  try { selectedReport.value = await api(`/api/reports/${encodeURIComponent(report.id)}`); view.value = 'report-detail'; }
  catch (error) { notify(error.message); }
}
function openReports(job = null) {
  selectedJob.value = job;
  view.value = 'reports';
}
function backToJobs() {
  selectedReport.value = null;
  view.value = selectedJob.value ? 'job-detail' : 'jobs';
}
function openLegacy() { location.href = `${location.pathname}?legacy=1`; }

onMounted(() => {
  window.addEventListener('app-toast', onToast);
  window.addEventListener('session-expired', onSessionExpired);
  if (!legacyMode.value) restoreSession();
});
onUnmounted(() => {
  window.removeEventListener('app-toast', onToast);
  window.removeEventListener('session-expired', onSessionExpired);
  clearTimeout(toastTimer.value);
});
</script>

<template>
  <LegacyBridge v-if="legacyMode" />
  <main v-else-if="loading" class="loading-screen" aria-live="polite">正在连接工作区…</main>
  <LoginView v-else-if="!user" @authenticated="authenticated" />
  <div v-else class="vue-app-shell">
    <header class="app-topbar">
      <a class="app-brand" href="/" @click.prevent="view = 'jobs'; selectedJob = null">面试智能体</a>
      <nav class="app-nav" aria-label="主导航">
        <button :class="{ active: view === 'jobs' || view === 'job-detail' }" @click="view = 'jobs'; selectedJob = null">岗位</button>
        <button :class="{ active: view === 'reports' || view === 'report-detail' }" @click="openReports(null)">报告</button>
      </nav>
      <div class="user-actions"><span>{{ user.name || user.account }}<small>{{ user.role === 'admin' ? '管理员' : '成员' }}</small></span><button class="secondary-button" @click="openLegacy">更多功能</button><button class="text-button" @click="logout">退出</button></div>
    </header>

    <main class="app-main">
      <JobWorkspace v-if="view === 'jobs'" :jobs="jobs" :reports="reports" :create-job="createJob" @open="selectedJob = $event; view = 'job-detail'" @delete="deleteJob" />
      <JobDetail v-else-if="view === 'job-detail' && selectedJob" :job="selectedJob" :reports="reports" @back="view = 'jobs'" @reports="openReports" @delete="deleteJob" @resume="openLegacy" />
      <ReportList v-else-if="view === 'reports'" :reports="selectedJobReports" :job="selectedJob" @open="openReport" @back="backToJobs" />
      <ReportDetail v-else-if="view === 'report-detail' && selectedReport" :report="selectedReport" @back="view = 'reports'" />
    </main>
    <div v-if="toast" class="toast-message" role="status">{{ toast }}</div>
  </div>
</template>
