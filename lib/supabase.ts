import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  'https://imloiwqyrlcodhlkrjrt.supabase.co',
  'sb_publishable_6HQYzrc0605XTpwff-RWYQ_d6BpSHdF'
)

export type RunnerLocation = {
  id?: string
  user_id: string
  team_id: string | null
  latitude: number
  longitude: number
  display_name: string | null
  updated_at: string
}