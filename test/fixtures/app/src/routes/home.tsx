import { useState } from 'react'
import { Card } from '@/components/Card'
import { Button as FormButton } from '../components/forms/Button'
import type { Props } from '../components/Icon'
import { Toolbar } from '@/components/Toolbar'
import missing from '@/components/Missing'

export default function Home() {
  const [n] = useState(0)
  return <main><Card /><FormButton /><Toolbar /></main>
}
