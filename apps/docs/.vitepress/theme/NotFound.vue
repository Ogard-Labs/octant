<script setup lang="ts">
import { withBase } from "vitepress";
</script>

<template>
  <section class="vp-doc octant-not-found">
    <h1>Page not found</h1>
    <p>This page does not exist in the Octant guide. It may have moved or been renamed.</p>
    <p>
      <a :href="withBase('/')">Octant docs home</a> ·
      <a :href="withBase('/guide/')">Start with the guide</a> ·
      <a href="https://github.com/Ogard-Labs/octant/tree/main/apps/docs">Edit the docs on GitHub</a>
    </p>
  </section>
</template>

<style scoped>
.octant-not-found {
  max-width: 688px;
  margin: 64px auto;
  padding: 0 24px;
}
</style>
