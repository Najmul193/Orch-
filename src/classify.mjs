// Heuristic task classifier: cheap, synchronous, and never fails. It tags a prompt
// so routing can prefer the model that suits that kind of work. Confidence is low by
// design — it only nudges the pick, the rest of the chain still backs it up.

const RULES = [
  ['ui', /\b(css|html|react|component|tailwind|button|layout|responsive|animation|color|palette|styling|style|frontend|front-end|tooltip|modal|dropdown|dashboard|page|theme|dark mode|ui|ux|pixel|flexbox|grid)\b/i],
  ['data', /\b(csv|json|sql|query|dataframe|spreadsheet|excel|parse|statistics|chart|plot|graph|dataset|regex|schema|aggregate|pivot|etl)\b/i],
  ['research', /\b(research|search|compare|comparison|survey|review|investigate|look up|find the best|top \d+|news|benchmark|vs\.?|alternatives|pros and cons|gather|sources?)\b/i],
  ['docs', /\b(readme|docstring|document|documentation|comment[s]?|summar(y|ise|ize)|summarize|translate|grammar|changelog|guide|explain|tutorial|blog|copywriting|note[s]?)\b/i],
  ['code', /\b(function|class|method|refactor|bug|fix|debug|implement|feature|script|api|endpoint|algorithm|compile|type|interface|import|module|test[s]?|lint|package|dependency|recursion|refactor|rename|callback|async|database|server|cli|serialize)\b/i],
]

export function classify(task = '') {
  const text = String(task)
  for (const [tag, re] of RULES) if (re.test(text)) return { tag, score: 1 }
  return { tag: 'general', score: 0 }
}

// Flat list of routing tags for config validation/UI.
export const TAGS = ['code', 'ui', 'docs', 'research', 'data', 'general']
