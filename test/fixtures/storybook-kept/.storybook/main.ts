import type { StorybookConfig } from '@storybook/vue3-vite'

const config: StorybookConfig = {
  // Docs pages, the component stories, then the patterns under their own prefix.
  stories: [
    '../src/**/*.mdx',
    '../src/components/**/*.stories.@(js|ts)',
    { directory: '../src/patterns', files: '**/*.stories.ts', titlePrefix: 'Patterns' },
  ],
  framework: { name: '@storybook/vue3-vite', options: {} },
}

export default config
