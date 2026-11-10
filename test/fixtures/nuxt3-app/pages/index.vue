<script setup lang="ts">
import { double } from '~/utils/math'

const n = double(2)
</script>

<template>
  <div>
    <TheHeader />
    <form-input :value="n" />
    <SiteIcon name="star" />
  </div>
</template>
