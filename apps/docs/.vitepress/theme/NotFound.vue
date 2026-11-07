<script setup lang="ts">
import DefaultTheme from "vitepress/theme";

const { NotFound } = DefaultTheme;
</script>

<template>
  <NotFound>
    <template #not-found-title>Page not found</template>
    <template #not-found-content>
      This page does not exist in the Octant guide — it may have moved or been renamed. The link and
      anchor checker on every pull request should keep links valid; if you followed one and landed
      here, the page is genuinely gone.
    </template>
    <template #not-found-action>
      <a href="/">Octant docs home</a> · <a href="/guide/">Start with the guide</a> ·
      <a href="https://github.com/Ogard-Labs/octant/tree/main/apps/docs">Edit the docs on GitHub</a>
    </template>
  </NotFound>
</template>
