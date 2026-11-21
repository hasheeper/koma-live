<script setup lang="ts">
const props = withDefaults(defineProps<{ subtitle?: string }>(), { subtitle: 'RIG' })
const glyph = import.meta.env.BASE_URL + 'mark.svg#koma-tiles'
</script>

<template>
  <span class="brand" role="img" :aria-label="'Koma ' + props.subtitle">
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24"><use :href="glyph" /></svg>
    </span>
    <span class="brand-wordmark" aria-hidden="true">
      <span class="brand-title">Koma</span>
      <span class="brand-subtitle">{{ props.subtitle }}</span>
    </span>
  </span>
</template>

<style scoped>
/* Koma Image / BrandMark.vue and public/styles/ui.css, with Rig theme tokens. */
.brand, .brand-wordmark { display: inline-flex; white-space: nowrap; }
.brand { align-items: center; flex: none; gap: 4px; }
.brand-mark {
  --m: var(--command-size);
  display: inline-grid;
  place-items: center;
  width: var(--m);
  height: var(--m);
  color: var(--accent);
}
/* Bare glyph in a command-sized cell: its optical inset now matches the icon buttons at the other end of the island. */
.brand-mark svg { width: 20px; height: 20px; fill: currentColor; }
/* RIG sits on Koma's baseline instead of floating at the box centre. */
.brand-wordmark { align-items: baseline; gap: 4px; line-height: 1; }
.brand-title {
  font: 650 19px/1 var(--brand);
  color: var(--fg-primary);
  background: linear-gradient(112deg, var(--fg-primary), var(--accent));
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.brand-subtitle { font: 600 9px/1 var(--brand); letter-spacing: .16em; color: var(--fg-muted); }
@media (max-width: 819px) {
  .brand { gap: 6px; }
  .brand-wordmark { gap: 4px; }
  .brand-title { font-size: 17px; }
}
/* Keep the project name readable when its island has very little space. */
@media (600px <= width <= 719px), (max-width: 420px) { .brand-wordmark { display: none; } }
</style>
