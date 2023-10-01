
/**
 * Performs a subsequent partition for each selector and returning rows matching in a Trie like structure.
 * 
 * This is effectively a multi-level Map.groupBy
 * 
 * @example
 *
 * ```mjs
 * // laundry
 * const items = [
 *   {wash: 'warm', result: 'bad',  brand: 'A'},
 *   {wash: 'cold', result: 'good', brand: 'A'},
 *   {wash: 'warm', result: 'good', brand: 'B'},
 *   {wash: 'cold', result: 'good', brand: 'B'},
 * ] as const
 * const grouped = partitionBy(items,
 *   _ => _.brand,
 *   _ => _.result,
 * )
 * for (const [brand, results] of grouped) {
 *   if (results.size === 1) {
 *     // no result variance across 1 brand
 *     const [result] = results.keys()
 *     console.log(brand,'always results in', result)
 *   } else {
 *     for (const [result, items] of results) {
 *       for (const item of items) {
 *         console.log(brand, 'results in', result, 'when washed using', item.wash)
 *       }
 *     }
 *   }
 * }
 * ```
 */
export function partitionBy<
  Item,
  Selects extends [...Array<(item: Item) => any>, (item: Item) => any]
>(arr: ReadonlyArray<Item>, ...selects: Selects): GroupedMapTrie<Item, ReturnTypes<Selects>> {
  const groupings = selects.slice(0, -1)
  const buckets = selects.at(-1)
  if (!buckets) {
    throw new Error('must include at least 1 selector')
  }
  // not using Map.groupBy due to that creating extra Maps only to be thrown away
  let root = new Map() as GroupedMapTrie<Item, ReturnTypes<Selects>>
  for (const item of arr) {
    // TS really doesn't like this kind of crawl
    let node = root as any
    let key
    for (const group of groupings) {
      key = group(item)
      const nextNode = node.get(key) ?? new Map()
      node.set(key, nextNode)
      node = nextNode
    }
    key = buckets(item)
    const existingBucket: Item[] = node.get() ?? []
    node.set(key, existingBucket)
    existingBucket.push(item)
  }
  return root
}

type GroupedMapTrie<Item, Keys extends [...any[]]> = Keys extends [... infer Groupings, infer Key] 
  ? GroupedMapTrieInner<Item, Groupings, Map<Key, Item[]>>
  : never
type GroupedMapTrieInner<Item, Keys, Leaves> = Keys extends [...infer Groupings, infer Key] 
  ? GroupedMapTrieInner<Item, Groupings, Map<Key, Leaves>>
  : Leaves
type ReturnTypes<Fns extends any[]> = Fns extends [... infer Body, infer Fn extends (...args: any) => any] 
  ? [...ReturnTypes<Body>, ReturnType<Fn>]
  : Fns extends [infer Fn extends (...args: any) => any]
    ? [ReturnType<Fn>]
    : []
