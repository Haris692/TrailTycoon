import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = 'https://yobmyrjccsxkuvafqiri.supabase.co'

const TRAININGS = [
  { id: 'easy_run', stats: { endurance: 1.5 }, energyCost: 10, healthGain: 0 },
  { id: 'long_run', stats: { endurance: 3, technique: 1 }, energyCost: 30, healthGain: 0 },
  { id: 'interval', stats: { speed: 2.5 }, energyCost: 25, healthGain: 0 },
  { id: 'hill_repeats', stats: { speed: 1.5, technique: 1.5 }, energyCost: 25, healthGain: 0 },
  { id: 'trail_run', stats: { technique: 2.5, endurance: 1 }, energyCost: 25, healthGain: 0 },
  { id: 'rest', stats: {}, energyCost: -40, healthGain: 10 },
  { id: 'yoga', stats: { mental: 2 }, energyCost: -10, healthGain: 8 },
  { id: 'mental_training', stats: { mental: 3 }, energyCost: 5, healthGain: 0 },
  { id: 'cross_training', stats: { endurance: 1, speed: 1 }, energyCost: 15, healthGain: 0 },
  { id: 'muscu', stats: { speed: 1.5, endurance: 1 }, energyCost: 20, healthGain: 3 },
  { id: 'renforcement', stats: { technique: 1.5, mental: 1 }, energyCost: 12, healthGain: 5 },
  { id: 'night_run', stats: { technique: 2, mental: 1.5 }, energyCost: 20, healthGain: 0 },
  { id: 'back_to_back', stats: { endurance: 4, mental: 2 }, energyCost: 50, healthGain: 0 },
  { id: 'altitude_camp', stats: { endurance: 5, speed: 2.5 }, energyCost: 40, healthGain: 0 },
]

function getTodayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

// Same diminishing returns formula as play.html
function calcTrainGain(currentStat: number, baseGain: number): number {
  const factor = Math.max(0.05, 1 - Math.pow(currentStat / 100, 1.5))
  return Math.max(0, Math.round(baseGain * factor * 10) / 10)
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    // Get user from JWT
    const supabaseUser = createClient(SUPABASE_URL, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser()
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Service role client for DB writes
    const supabase = createClient(SUPABASE_URL, serviceRoleKey)

    const { training_id } = await req.json()
    if (!training_id) {
      return new Response(JSON.stringify({ error: 'Missing training_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const training = TRAININGS.find(t => t.id === training_id)
    if (!training) {
      return new Response(JSON.stringify({ error: 'Invalid training_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch profile (PK is `id`, which matches auth.users id)
    const { data: profile, error: profileError } = await supabase
      .from('lb_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (profileError || !profile) {
      return new Response(JSON.stringify({ error: 'Profile not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const today = getTodayStr()
    const stats = profile.stats || { endurance: 5, speed: 5, technique: 5, mental: 5 }

    // Check training limit (reset if different day)
    const trainingsToday = profile.last_training_date === today ? (profile.trainings_today ?? 0) : 0
    if (trainingsToday >= 2) {
      return new Response(JSON.stringify({ error: 'Maximum 2 trainings per day reached' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Check energy
    if (training.energyCost > 0 && profile.energy < training.energyCost) {
      return new Response(JSON.stringify({ error: 'Not enough energy' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Check injury
    if (profile.is_injured && training.id !== 'rest' && training.id !== 'yoga') {
      return new Response(JSON.stringify({ error: 'You are injured. Only rest or yoga allowed.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Save before state
    const statsBefore = { ...stats }
    const energyBefore = profile.energy

    // Apply stat gains with diminishing returns
    const newStats = { ...stats }
    const gains: Record<string, number> = {}
    for (const [stat, baseGain] of Object.entries(training.stats)) {
      const currentVal = newStats[stat] ?? 0
      const gain = calcTrainGain(currentVal, baseGain as number)

      // Fatigue penalty on effectiveness
      let effMult = 1
      if (profile.fatigue > 90) effMult = 0.5
      else if (profile.fatigue > 70) effMult = 0.5

      const actualGain = Math.round(gain * effMult * 10) / 10
      newStats[stat] = Math.min(99, currentVal + actualGain)
      gains[stat] = actualGain
    }

    // Fatigue changes
    let newFatigue = profile.fatigue
    if (training.id === 'rest') {
      newFatigue = Math.max(0, newFatigue - 25)
    } else if (training.id === 'yoga') {
      newFatigue = Math.max(0, newFatigue - 15)
    } else {
      newFatigue = Math.min(100, newFatigue + (training.energyCost > 0 ? training.energyCost * 0.3 : 0))
    }

    // Energy
    const newEnergy = Math.max(0, Math.min(100, profile.energy - training.energyCost))

    // Health
    let newHealth = profile.health
    if (training.healthGain > 0) {
      newHealth = Math.min(100, newHealth + training.healthGain)
    }

    // Update profile
    const { error: updateError } = await supabase
      .from('lb_profiles')
      .update({
        stats: newStats,
        energy: newEnergy,
        fatigue: newFatigue,
        health: newHealth,
        trainings_today: trainingsToday + 1,
        last_training_date: today,
        last_active_date: today,
      })
      .eq('id', user.id)

    if (updateError) {
      return new Response(JSON.stringify({ error: 'Failed to update profile', details: updateError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Insert training log
    await supabase.from('lb_training_log').insert({
      user_id: user.id,
      training_id: training.id,
      stats_before: statsBefore,
      stats_after: newStats,
      energy_before: energyBefore,
      energy_after: newEnergy,
    })

    // Re-fetch updated profile to return
    const { data: updatedProfile } = await supabase
      .from('lb_profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    return new Response(JSON.stringify({
      profile: updatedProfile,
      gains,
    }), {
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
