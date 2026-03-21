import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = 'https://yobmyrjccsxkuvafqiri.supabase.co'

const RANDOM_INJURIES = [
  'IT Band Syndrome',
  'Achilles Tendinitis',
  'Shin Splints',
  'Plantar Fasciitis',
  'Muscle Strain',
  'Ankle Sprain',
]

function daysBetween(dateStr: string, now: Date): number {
  const d = new Date(dateStr)
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const supabase = createClient(SUPABASE_URL, serviceRoleKey)

    const now = new Date()
    const today = now.toISOString().slice(0, 10)

    const { data: profiles, error: fetchError } = await supabase
      .from('lb_profiles')
      .select('*')

    if (fetchError || !profiles) {
      return new Response(JSON.stringify({ error: 'Failed to fetch profiles', details: fetchError?.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let updated = 0
    let errors = 0

    for (const profile of profiles) {
      const stats = profile.stats || { endurance: 5, speed: 5, technique: 5, mental: 5 }
      const newStats = { ...stats }

      const updates: Record<string, unknown> = {
        trainings_today: 0,
        energy: Math.min(100, (profile.energy ?? 0) + 15),
        fatigue: Math.max(0, (profile.fatigue ?? 0) - 5),
        health: Math.min(100, (profile.health ?? 0) + 3),
      }

      // Inactivity decay
      if (profile.last_active_date) {
        const inactiveDays = daysBetween(profile.last_active_date, now)

        if (inactiveDays > 3) {
          const decayAmount = 0.3 * inactiveDays
          newStats.endurance = Math.max(1, (newStats.endurance ?? 5) - decayAmount)
          newStats.speed = Math.max(1, (newStats.speed ?? 5) - decayAmount)
          newStats.technique = Math.max(1, (newStats.technique ?? 5) - decayAmount)
          newStats.mental = Math.max(1, (newStats.mental ?? 5) - decayAmount)
          updates.fatigue = Math.min(100, (updates.fatigue as number) + 5)
        }

        // Injury risk for very inactive players
        if (inactiveDays > 7 && !profile.is_injured) {
          if (Math.random() < 0.10) {
            const injuryName = RANDOM_INJURIES[Math.floor(Math.random() * RANDOM_INJURIES.length)]
            const injuryEnds = new Date(now)
            injuryEnds.setDate(injuryEnds.getDate() + 2 + Math.floor(Math.random() * 3))
            updates.is_injured = true
            updates.injury_name = injuryName
            updates.injury_ends_at = injuryEnds.toISOString().slice(0, 10)
          }
        }
      }

      updates.stats = newStats

      // Handle injury healing
      if (profile.is_injured && profile.injury_ends_at) {
        if (profile.injury_ends_at <= today) {
          updates.is_injured = false
          updates.injury_name = null
          updates.injury_ends_at = null
        }
      }

      const { error: updateError } = await supabase
        .from('lb_profiles')
        .update(updates)
        .eq('id', profile.id)

      if (updateError) errors++
      else updated++
    }

    return new Response(JSON.stringify({ success: true, updated, errors, total: profiles.length }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Internal server error', details: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
