// Stand-in agent CLI for tests. Behaviour is picked by the "model" name.
const mode = process.argv[2]
if (mode === 'limited') {
  console.log(JSON.stringify({ error: 'HTTP 429: rate limit exceeded' }))
  process.exit(1)
}
if (mode === 'broken') {
  console.log(JSON.stringify({ error: 'model crashed' }))
  process.exit(1)
}
if (mode === 'slow') setTimeout(() => {}, 60_000)
else console.log(JSON.stringify({ text: `done by ${mode}${process.argv[3]?.includes("previous attempt") ? " after retry" : ""}` }))
