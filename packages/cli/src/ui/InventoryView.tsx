import type { Herzie, Inventory } from "@herzies/shared";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useState } from "react";
import { getItem, RARITY_COLORS, RARITY_LABELS } from "../art/items.js";
import {
  apiEquipItem,
  apiFetchInventory,
  apiSellItem,
  isLoggedIn,
} from "../storage/api.js";
import { ItemDisplay } from "./ItemDisplay.js";

interface Props {
  herzie: Herzie;
  onBack: () => void;
  online?: string;
}

type SellMode = null | { itemId: string; name: string; maxQty: number };

export function InventoryView({ herzie, onBack, online }: Props) {
  const [selected, setSelected] = useState(0);
  const [viewing, setViewing] = useState<string | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [currency, setCurrency] = useState(herzie.currency);
  const [loading, setLoading] = useState(true);
  const [equipped, setEquipped] = useState<string[]>([]);
  const [sellMode, setSellMode] = useState<SellMode>(null);
  const [sellMessage, setSellMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoggedIn()) {
      setLoading(false);
      return;
    }
    apiFetchInventory().then((result) => {
      if (result) {
        setInventory(result.inventory);
        setCurrency(result.currency);
        setEquipped(result.equipped);
      } else {
        setInventory({});
      }
      setLoading(false);
    });
  }, []);

  // Get sorted item entries (non-zero quantities)
  const rarityOrder: Record<string, number> = {
    legendary: 0,
    rare: 1,
    uncommon: 2,
    common: 3,
  };
  const entries = inventory
    ? Object.entries(inventory)
        .filter(([, qty]) => qty > 0)
        .sort((a, b) => {
          const ra = rarityOrder[getItem(a[0])?.rarity ?? "common"] ?? 3;
          const rb = rarityOrder[getItem(b[0])?.rarity ?? "common"] ?? 3;
          if (ra !== rb) return ra - rb;
          return (getItem(a[0])?.name ?? a[0]).localeCompare(
            getItem(b[0])?.name ?? b[0],
          );
        })
    : [];

  useInput((_input, key) => {
    // Sell confirmation mode
    if (sellMode) {
      if (_input === "1") {
        doSell(sellMode.itemId, 1);
      } else if (_input === "5") {
        doSell(sellMode.itemId, Math.min(5, sellMode.maxQty));
      } else if (_input === "a") {
        doSell(sellMode.itemId, sellMode.maxQty);
      } else if (key.escape || _input === "q") {
        setSellMode(null);
      }
      return;
    }

    if (viewing) {
      if (key.escape || key.return || _input === "q") {
        setViewing(null);
      }
      return;
    }

    if (key.escape || _input === "q") {
      onBack();
      return;
    }

    if (!inventory || entries.length === 0) return;

    if (key.upArrow) {
      setSelected((s) => Math.max(0, s - 1));
    }
    if (key.downArrow) {
      setSelected((s) => Math.min(entries.length - 1, s + 1));
    }
    if (key.return && entries.length > 0) {
      setViewing(entries[selected][0]);
    }
    if (_input === "s" && entries.length > 0) {
      const [itemId, qty] = entries[selected];
      const item = getItem(itemId);
      if (item?.stackable && item?.sellPrice) {
        setSellMode({ itemId, name: item.name, maxQty: qty });
        setSellMessage(null);
      }
    }
    if (_input === "e" && entries.length > 0) {
      const [itemId] = entries[selected];
      const item = getItem(itemId);
      if (item?.equipable) {
        const isEquipped = equipped.includes(itemId);
        doEquip(itemId, isEquipped ? "unequip" : "equip");
      }
    }
  });

  async function doEquip(itemId: string, action: "equip" | "unequip") {
    const result = await apiEquipItem(itemId, action);
    if (result) {
      setEquipped(result.equipped);
      setSellMessage(action === "equip" ? "Equipped!" : "Unequipped!");
    } else {
      setSellMessage("Failed to update equipment.");
    }
  }

  async function doSell(itemId: string, quantity: number) {
    const result = await apiSellItem(itemId, quantity);
    if (result) {
      setInventory(result.inventory);
      setCurrency(result.newCurrency);
      setSellMessage(`Sold ${quantity}x for $${result.earned}!`);
    } else {
      setSellMessage("Failed to sell.");
    }
    setSellMode(null);
  }

  if (!isLoggedIn()) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">
          Log in to access your inventory. Run <Text bold>herzies login</Text>
        </Text>
        <Box marginTop={1}>
          <Text dimColor>Press q to go back</Text>
        </Box>
      </Box>
    );
  }

  if (online && online !== "online") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">Inventory is only available when online.</Text>
        <Box marginTop={1}>
          <Text dimColor>Press q to go back</Text>
        </Box>
      </Box>
    );
  }

  if (loading) {
    return (
      <Box padding={1}>
        <Text dimColor>Loading inventory...</Text>
      </Box>
    );
  }

  // Sell confirmation overlay
  if (sellMode) {
    const item = getItem(sellMode.itemId);
    const price = item?.sellPrice ?? 0;
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">
          Sell {sellMode.name}? ({sellMode.maxQty} owned, ${price} each)
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            {" "}
            <Text bold>1</Text> — Sell 1 (${price})
          </Text>
          {sellMode.maxQty >= 5 && (
            <Text>
              {" "}
              <Text bold>5</Text> — Sell 5 (${price * 5})
            </Text>
          )}
          <Text>
            {" "}
            <Text bold>a</Text> — Sell all {sellMode.maxQty} ($
            {price * sellMode.maxQty})
          </Text>
          <Text>
            {" "}
            <Text bold>Esc</Text> — Cancel
          </Text>
        </Box>
      </Box>
    );
  }

  if (entries.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">
          Balance: ${currency}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>No items yet — keep listening to earn some!</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press q to go back</Text>
        </Box>
      </Box>
    );
  }

  // Item detail view
  if (viewing) {
    const item = getItem(viewing);
    const qty = inventory?.[viewing] ?? 0;
    return (
      <Box flexDirection="column" padding={1}>
        <Box>
          <Text bold color={item ? RARITY_COLORS[item.rarity] : "magenta"}>
            {item?.name ?? viewing}
          </Text>
          {qty > 1 && <Text color="yellow"> x{qty}</Text>}
          {item && (
            <Text color={RARITY_COLORS[item.rarity]} dimColor>
              {" "}
              — {RARITY_LABELS[item.rarity]}
            </Text>
          )}
        </Box>
        {item?.description && (
          <Text dimColor italic>
            {item.description}
          </Text>
        )}
        {equipped.includes(viewing) && <Text color="green">[Equipped]</Text>}
        {item?.sellPrice && (
          <Text dimColor>Sell price: ${item.sellPrice} each</Text>
        )}
        <Box marginTop={1}>
          <ItemDisplay itemId={viewing} animate />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Press Esc or Enter to go back</Text>
        </Box>
      </Box>
    );
  }

  // List view
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="magenta">
        ♫ {herzie.name}'s inventory
      </Text>
      <Text bold color="yellow">
        Balance: ${currency}
      </Text>
      {sellMessage && <Text color="green">{sellMessage}</Text>}
      <Box marginTop={1} flexDirection="column">
        {entries.map(([id, qty], i) => {
          const item = getItem(id);
          const isSelected = i === selected;
          return (
            <Box key={id}>
              <Text color={isSelected ? "yellow" : undefined}>
                {isSelected ? "▸ " : "  "}
              </Text>
              <Text color={item ? RARITY_COLORS[item.rarity] : undefined}>
                {item?.name ?? id}
              </Text>
              {qty > 1 && <Text dimColor> x{qty}</Text>}
              {equipped.includes(id) && <Text color="green"> [equipped]</Text>}
              {item?.sellPrice && isSelected && (
                <Text dimColor> (${item.sellPrice})</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate · Enter to view · e to equip · s to sell · q to go back
        </Text>
      </Box>
    </Box>
  );
}
