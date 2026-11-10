import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'

// Sample entries only the stories read.
const samples = defineCollection({ loader: glob({ base: './src/stories/fixtures/samples', pattern: '**/*.md' }) })

export const collections = { samples }
