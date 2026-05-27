import { Box, render, Text, useApp } from "ink";
import React from "react";
import { loadHerzie } from "../storage/state.js";
import { InventoryView } from "../ui/InventoryView.js";

function InventoryApp() {
  const { exit } = useApp();
  const herzie = loadHerzie();

  if (!herzie) {
    return (
      <Box padding={1}>
        <Text color="yellow">
          No Herzie found! Run <Text bold>herzies hatch</Text> to get started.
        </Text>
      </Box>
    );
  }

  return <InventoryView herzie={herzie} onBack={exit} />;
}

export function runInventory() {
  render(<InventoryApp />);
}
