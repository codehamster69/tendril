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

// Daily briefs (K2): one reference program per goal. Their results set each brief's par (90% of the mean over the visible and hidden
// farms). Copies of packages/lang/examples/brief-<goal>.sprout; a test keeps them identical.
export type BriefGoal = 'wealth' | 'festival' | 'specialist' | 'orders' | 'inherited';
export const REFERENCE_SOURCES: Record<BriefGoal, string> = {
  wealth: `# Plain wealth: research wheat, farm every tile, sell, and spend on bots and land when the farm can pay for them.
# Bought land is not always in a straight line from the barn, so if the direct walk is blocked
# try the other axis first, and give up on a tile that cannot be reached.
define walk(t):
    if go_to(t):
        return true
    here = position()
    if go_to({x: here.x, y: t.y}) and go_to(t):
        return true
    # Lost: head back to the barn (either way round) so the next tile starts from a known place.
    if not go_to(barn):
        go_to({x: position().x, y: 0})
        go_to(barn)
    return false

# Only the first bot spends. A refused purchase (a cap, a blocked spot) just returns false and costs nothing.
define buy_next_plot():
    for each p in plots():
        for each d in [{x: 1, y: 0}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 0, y: -1}]:
            if buy_plot(p.px + d.x, p.py + d.y):
                return true
    return false

define spend(reserve):
    if bots() < 2 * len(plots()) and bot_cost() > 0 and coins() >= bot_cost() + reserve:
        buy_bot
    elif plot_cost() > 0 and coins() >= plot_cost() + reserve:
        buy_next_plot()

define sell_all():
    go_to nearest_drop()
    deposit
    sell carrot, all
    sell wheat, all

repeat forever:
    if my_id() == 0 and not unlocked(wheat) and coins() >= unlock_cost(wheat) + 20:
        unlock wheat
    crop = carrot
    if unlocked(wheat):
        crop = wheat
    ts = tiles()
    for i from 0 to len(ts) - 1:
        if i % bots() == my_id() and walk(ts[i]):
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant crop
            if carried() >= capacity():
                sell_all()
    sell_all()
    if my_id() == 0:
        spend(50)
    wait 20
`,
  festival: `# The village fair wants set amounts of some crops. Grow whichever still has the most to go, and deposit it.
# A deposit counts toward the fair even if the crop is sold afterwards, so everything is sold to pay for research and growth.
define remaining_best():
    best = none
    for each crop in [carrot, wheat, clover, pumpkin, berry, apple]:
        if quota(crop) > 0 and unlocked(crop):
            if best is none or quota(crop) > quota(best):
                best = crop
    return best

# What the cheapest locked crop the fair wants costs, or 0 when there is none: that is what to save for.
define saving_for():
    cheapest = 0
    for each crop in [wheat, clover, pumpkin, berry, apple]:
        if quota(crop) > 0 and not unlocked(crop):
            if cheapest == 0 or unlock_cost(crop) < cheapest:
                cheapest = unlock_cost(crop)
    return cheapest

# Bought land is not always in a straight line from the barn, so if the direct walk is blocked
# try the other axis first, and give up on a tile that cannot be reached.
define walk(t):
    if go_to(t):
        return true
    here = position()
    if go_to({x: here.x, y: t.y}) and go_to(t):
        return true
    # Lost: head back to the barn (either way round) so the next tile starts from a known place.
    if not go_to(barn):
        go_to({x: position().x, y: 0})
        go_to(barn)
    return false

# Only the first bot spends. A refused purchase (a cap, a blocked spot) just returns false and costs nothing.
define buy_next_plot():
    for each p in plots():
        for each d in [{x: 1, y: 0}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 0, y: -1}]:
            if buy_plot(p.px + d.x, p.py + d.y):
                return true
    return false

define spend(reserve):
    if bots() < 2 * len(plots()) and bot_cost() > 0 and coins() >= bot_cost() + reserve:
        buy_bot
    elif plot_cost() > 0 and coins() >= plot_cost() + reserve:
        buy_next_plot()

repeat forever:
    if my_id() == 0:
        # Research a crop the fair needs as soon as we can pay for it.
        for each crop in [wheat, clover, pumpkin, berry, apple]:
            if quota(crop) > 0 and not unlocked(crop) and coins() >= unlock_cost(crop):
                unlock crop
    crop = remaining_best()
    if crop is none:
        # Nothing the fair wants is unlocked yet: grow the best seller until it can be researched.
        crop = carrot
        if unlocked(wheat):
            crop = wheat
    ts = tiles()
    for i from 0 to len(ts) - 1:
        if i % bots() == my_id() and walk(ts[i]):
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant crop
            if carried() >= capacity():
                go_to nearest_drop()
                deposit
    go_to nearest_drop()
    deposit
    if my_id() == 0:
        # Sell everything: the deposit has already counted.
        for each crop in [carrot, wheat, clover, pumpkin, berry, apple]:
            sell crop, all
        spend(50 + saving_for())
    wait 20
`,
  specialist: `# Today's prices are skewed: grow whatever pays best per tick, and research it when we can afford to.
define worth(crop):
    # Price times yield over the ripening time (yield and stage length are fixed game rules).
    if crop is carrot:
        return price(carrot) * 4 * 100 / 180
    if crop is wheat:
        return price(wheat) * 8 * 100 / 270
    if crop is pumpkin:
        return price(pumpkin) * 20 * 100 / 450
    if crop is berry:
        return price(berry) * 6 * 100 / 240
    return 0

define best_crop():
    best = carrot
    for each crop in [wheat, pumpkin, berry]:
        if unlocked(crop) and worth(crop) > worth(best):
            best = crop
    return best

# Bought land is not always in a straight line from the barn, so if the direct walk is blocked
# try the other axis first, and give up on a tile that cannot be reached.
define walk(t):
    if go_to(t):
        return true
    here = position()
    if go_to({x: here.x, y: t.y}) and go_to(t):
        return true
    # Lost: head back to the barn (either way round) so the next tile starts from a known place.
    if not go_to(barn):
        go_to({x: position().x, y: 0})
        go_to(barn)
    return false

# Only the first bot spends. A refused purchase (a cap, a blocked spot) just returns false and costs nothing.
define buy_next_plot():
    for each p in plots():
        for each d in [{x: 1, y: 0}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 0, y: -1}]:
            if buy_plot(p.px + d.x, p.py + d.y):
                return true
    return false

define spend(reserve):
    if bots() < 2 * len(plots()) and bot_cost() > 0 and coins() >= bot_cost() + reserve:
        buy_bot
    elif plot_cost() > 0 and coins() >= plot_cost() + reserve:
        buy_next_plot()

define sell_all():
    go_to nearest_drop()
    deposit
    for each crop in [carrot, wheat, pumpkin, berry]:
        sell crop, all

repeat forever:
    # Research the crop that pays best, once there is money for it.
    if my_id() == 0:
        for each crop in [wheat, pumpkin, berry]:
            if not unlocked(crop) and worth(crop) > worth(best_crop()) and coins() >= unlock_cost(crop):
                unlock crop
    crop = best_crop()
    ts = tiles()
    for i from 0 to len(ts) - 1:
        if i % bots() == my_id() and walk(ts[i]):
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant crop
            if carried() >= capacity():
                sell_all()
    sell_all()
    if my_id() == 0:
        spend(50)
    wait 20
`,
  orders: `# Only village orders pay today: grow what they ask for and deliver as soon as the barn can cover one.
define wanted():
    # The unlocked crop of the order that pays most per unit.
    best = carrot
    best_rate = 0
    for each order in orders():
        if unlocked(order.crop) and order.reward / order.qty > best_rate:
            best = order.crop
            best_rate = order.reward / order.qty
    return best

# Bought land is not always in a straight line from the barn, so if the direct walk is blocked
# try the other axis first, and give up on a tile that cannot be reached.
define walk(t):
    if go_to(t):
        return true
    here = position()
    if go_to({x: here.x, y: t.y}) and go_to(t):
        return true
    # Lost: head back to the barn (either way round) so the next tile starts from a known place.
    if not go_to(barn):
        go_to({x: position().x, y: 0})
        go_to(barn)
    return false

# Only the first bot spends. A refused purchase (a cap, a blocked spot) just returns false and costs nothing.
define buy_next_plot():
    for each p in plots():
        for each d in [{x: 1, y: 0}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 0, y: -1}]:
            if buy_plot(p.px + d.x, p.py + d.y):
                return true
    return false

define spend(reserve):
    if bots() < 2 * len(plots()) and bot_cost() > 0 and coins() >= bot_cost() + reserve:
        buy_bot
    elif plot_cost() > 0 and coins() >= plot_cost() + reserve:
        buy_next_plot()

define deliver_all():
    go_to nearest_drop()
    deposit
    for each order in orders():
        if stock()[order.crop] >= order.qty:
            deliver order

repeat forever:
    crop = wanted()
    ts = tiles()
    for i from 0 to len(ts) - 1:
        if i % bots() == my_id() and walk(ts[i]):
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant crop
            if carried() >= capacity():
                deliver_all()
    deliver_all()
    if my_id() == 0:
        # Research a crop an order is asking for if it is locked and affordable, then grow the farm.
        for each order in orders():
            if not unlocked(order.crop) and coins() >= unlock_cost(order.crop):
                unlock order.crop
        spend(50)
    wait 20
`,
  inherited: `# The farm is already half-planted: harvest what is growing, replant it, and spend what it earns on more.
# Bought land is not always in a straight line from the barn, so if the direct walk is blocked
# try the other axis first, and give up on a tile that cannot be reached.
define walk(t):
    if go_to(t):
        return true
    here = position()
    if go_to({x: here.x, y: t.y}) and go_to(t):
        return true
    # Lost: head back to the barn (either way round) so the next tile starts from a known place.
    if not go_to(barn):
        go_to({x: position().x, y: 0})
        go_to(barn)
    return false

# Only the first bot spends. A refused purchase (a cap, a blocked spot) just returns false and costs nothing.
define buy_next_plot():
    for each p in plots():
        for each d in [{x: 1, y: 0}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 0, y: -1}]:
            if buy_plot(p.px + d.x, p.py + d.y):
                return true
    return false

define spend(reserve):
    if bots() < 2 * len(plots()) and bot_cost() > 0 and coins() >= bot_cost() + reserve:
        buy_bot
    elif plot_cost() > 0 and coins() >= plot_cost() + reserve:
        buy_next_plot()

define sell_all():
    go_to nearest_drop()
    deposit
    sell carrot, all
    sell wheat, all
    sell clover, all

repeat forever:
    ts = tiles()
    for i from 0 to len(ts) - 1:
        if i % bots() == my_id() and walk(ts[i]):
            if scan().ripe:
                harvest
            if scan().empty:
                till
                plant wheat
            if carried() >= capacity():
                sell_all()
    sell_all()
    if my_id() == 0:
        spend(50)
    wait 20
`,
};
