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
export function partitionBy(arr, ...selects) {
    const groupings = selects.slice(0, -1);
    const buckets = selects.at(-1);
    if (!buckets) {
        throw new Error('must include at least 1 selector');
    }
    // not using Map.groupBy due to that creating extra Maps only to be thrown away
    let root = new Map();
    for (const item of arr) {
        // TS really doesn't like this kind of crawl
        let node = root;
        let key;
        for (const group of groupings) {
            key = group(item);
            const nextNode = node.get(key) ?? new Map();
            node.set(key, nextNode);
            node = nextNode;
        }
        key = buckets(item);
        const existingBucket = node.get() ?? [];
        node.set(key, existingBucket);
        existingBucket.push(item);
    }
    return root;
}
