<script setup>
import { onMounted, ref } from 'vue';
import { initLegacyApp } from './legacy/legacy-app.js';
import legacyMarkup from './legacy/legacy.html?raw';
import './legacy/legacy.css';

const root = ref(null);
onMounted(() => {
  root.value.innerHTML = legacyMarkup;
  initLegacyApp();
});
</script>

<template><div ref="root"></div></template>
