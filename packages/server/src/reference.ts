// The reference program that sets par: a copy of packages/lang/examples/daily.sprout (a test keeps them identical).
// The server never runs it; it is sent to the separate verify function when a challenge is created.
export const REFERENCE_SOURCE = `# A short growing route leaves more time for harvesting and selling.
repeat forever:
    for each tile in [{x: 1, y: 0}, {x: 2, y: 0}, {x: 3, y: 0}, {x: 4, y: 0}, {x: 5, y: 0}]:
        go_to tile
        if scan().ripe:
            harvest
        if scan().empty:
            till
            plant carrot
    go_to barn
    deposit
    for each order in orders():
        if stock()[order.crop] >= order.qty:
            deliver order
    sell carrot, all
    wait 100
`;
