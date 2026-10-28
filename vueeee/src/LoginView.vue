<script setup>
import { ref } from 'vue';
import { api } from './api.js';

const emit = defineEmits(['authenticated']);
const mode = ref('login');
const account = ref('admin');
const name = ref('');
const password = ref('');
const passwordConfirm = ref('');
const error = ref('');
const busy = ref(false);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    if (mode.value === 'register' && password.value !== passwordConfirm.value) {
      throw new Error('两次输入的密码不一致');
    }
    const path = mode.value === 'login' ? '/api/auth/login' : '/api/auth/register';
    const body = mode.value === 'login'
      ? { account: account.value, password: password.value }
      : { account: account.value, name: name.value, password: password.value };
    emit('authenticated', await api(path, { method: 'POST', body }));
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="login-shell">
    <form class="login-panel" @submit.prevent="submit">
      <div class="brand-mark">面</div>
      <p class="eyebrow">INTERVIEW WORKSPACE</p>
      <h1>面试智能体</h1>
      <p class="muted">把面试交给 AI，你专注审核与决定。</p>

      <label class="field-label" for="account">{{ mode === 'login' ? '登录账号' : '账号' }}</label>
      <input id="account" v-model.trim="account" autocomplete="username" required placeholder="字母、数字或 . _ + -" />

      <template v-if="mode === 'register'">
        <label class="field-label" for="display-name">显示名</label>
        <input id="display-name" v-model.trim="name" maxlength="30" placeholder="可选" />
      </template>

      <label class="field-label" for="password">密码</label>
      <input id="password" v-model="password" type="password" autocomplete="current-password" required minlength="6" />
      <template v-if="mode === 'register'">
        <label class="field-label" for="password-confirm">确认密码</label>
        <input id="password-confirm" v-model="passwordConfirm" type="password" required minlength="6" />
      </template>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="primary-button full-button" type="submit" :disabled="busy">
        {{ busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录' }}
      </button>
      <p class="switch-mode">
        {{ mode === 'login' ? '还没有账号？' : '已有账号？' }}
        <button type="button" class="text-button" @click="mode = mode === 'login' ? 'register' : 'login'; error = ''">
          {{ mode === 'login' ? '注册一个' : '返回登录' }}
        </button>
      </p>
      <p v-if="mode === 'login'" class="demo-hint">演示账号：admin / demo1234</p>
    </form>
  </main>
</template>
