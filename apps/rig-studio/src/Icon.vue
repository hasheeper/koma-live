<script setup lang="ts">
defineProps<{ name: string }>()
const sprite = import.meta.env.BASE_URL + 'icons.svg#i-'
</script>
<template>
  <svg class="icon" :data-icon="name" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <g v-if="name === 'bone'">
      <path d="M6.4 17.6 9.3 10.6 19.6 4.4 13.4 14.7Z" fill="currentColor" stroke="none"/>
      <circle cx="6.4" cy="17.6" r="2.1" fill="none" stroke="currentColor" stroke-width="1.8"/>
    </g>
    <g v-else-if="name === 'bone-point'" fill="currentColor" stroke="none">
      <rect x="10.7" y="2.5" width="2.6" height="6.2" rx=".7"/>
      <rect x="10.7" y="15.3" width="2.6" height="6.2" rx=".7"/>
      <rect x="2.5" y="10.7" width="6.2" height="2.6" rx=".7"/>
      <rect x="15.3" y="10.7" width="6.2" height="2.6" rx=".7"/>
    </g>
    <g v-else-if="name==='pick'" stroke-width="1.65">
      <path d="m14.5 7.5 2-2a2.1 2.1 0 0 1 3 3l-2 2m-5-5 6 6M14 8 5.5 16.5 4 20l3.5-1.5L16 10"/>
    </g>
    <g v-else-if="name==='unlock'">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"/>
    </g>
    <g v-else-if="name==='trash'" stroke-width="1.65">
      <path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/>
      <path d="M6.5 7l.8 11.5A2 2 0 0 0 9.3 20.5h5.4a2 2 0 0 0 2-2L17.5 7"/>
      <path d="M10.2 11v5.5M13.8 11v5.5"/>
    </g>
    <g v-else-if="name==='reset-pose'" stroke-width="1.65">
      <path d="M5 12a7 7 0 1 0 2-4.95L5 9"/>
      <path d="M5 4.8V9h4.2"/>
    </g>
    <g v-else-if="name==='live'" stroke-width="1.7">
      <path d="M3 12h3.2l2.4-6 4 12 2.6-6H21"/>
    </g>
    <g v-else-if="name==='play'" fill="currentColor" stroke="none">
      <path d="M7.5 5.4 19 12 7.5 18.6Z"/>
    </g>
    <g v-else-if="name==='pause'" fill="currentColor" stroke="none">
      <rect x="6.5" y="5.5" width="3.8" height="13" rx="1"/>
      <rect x="13.7" y="5.5" width="3.8" height="13" rx="1"/>
    </g>
    <g v-else-if="name==='reload'" stroke-width="1.65">
      <path d="M19 12a7 7 0 1 1-2.05-4.95L19 9"/>
      <path d="M19 4.8V9h-4.2"/>
    </g>
    <g v-else-if="name==='auto-reload'" stroke-width="1.6">
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>
      <path d="M8.1 8.1a5.5 5.5 0 0 0 0 7.8M15.9 8.1a5.5 5.5 0 0 1 0 7.8"/>
      <path d="M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>
    </g>
    <g v-else-if="name==='recent'" stroke-width="1.6">
      <circle cx="12" cy="12" r="8"/>
      <path d="M12 7.5V12l3 2"/>
    </g>
    <g v-else-if="name==='frame-card'" stroke-width="1.55">
      <rect x="5" y="3.5" width="14" height="17" rx="2.2"/>
      <path d="M8.5 16.5h7"/>
    </g>
    <g v-else-if="name==='copy'" stroke-width="1.55">
      <rect x="9" y="9" width="10.5" height="10.5" rx="1.8"/>
      <path d="M15 9V6.3A1.8 1.8 0 0 0 13.2 4.5H6.3A1.8 1.8 0 0 0 4.5 6.3v6.9A1.8 1.8 0 0 0 6.3 15H9"/>
    </g>
    <g v-else-if="name === 'layer-slot'">
      <circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" stroke-width="2.1"/>
      <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none"/>
    </g>
    <g v-else-if="name === 'region-attach'">
      <rect x="3.5" y="4.5" width="17" height="15" rx="1.8" fill="var(--icon-image-fill, currentColor)" stroke="var(--icon-image, currentColor)" stroke-width="1.7"/>
      <path d="M5.5 17.5 10 12.2l2.8 3 2.4-2.8 3.3 5.1Z" fill="var(--icon-image, currentColor)" stroke="none"/>
      <circle cx="8.8" cy="8.8" r="1.6" fill="var(--icon-image, currentColor)" stroke="none"/>
    </g>
    <g v-else-if="name==='vertex-add' || name==='vertex-remove'" stroke-width="1.5">
      <path d="M3 17 9 8l5 4"/><circle cx="9" cy="8" r="2" fill="currentColor" stroke="none"/>
      <path d="M13 16h8"/><path v-if="name==='vertex-add'" d="M17 12v8"/>
    </g>
    <g v-else-if="name === 'mesh'">
      <path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5M12 5.5 5.5 12l6.5 6.5 6.5-6.5Z" fill="none" stroke="var(--icon-mesh-wire, currentColor)" stroke-width="1.45"/>
      <path d="M5.5 5.5h13v13h-13Z" fill="none" stroke="var(--icon-mesh-edge, currentColor)" stroke-width="1.55"/>
      <rect v-for="[x,y] in [[3,3],[17,3],[3,17],[17,17]]" :x="x" :y="y" width="4" height="4" rx=".6" fill="var(--icon-mesh-node, currentColor)" stroke="none"/>
    </g>
    <use v-else :href="sprite + name"/>
  </svg>
</template>
