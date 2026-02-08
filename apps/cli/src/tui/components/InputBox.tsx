import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";

interface InputBoxProps {
  onSubmit: (message: string) => void;
  isDisabled: boolean;
  isFocused: boolean;
}

const MAX_HISTORY = 100;

export function InputBox({ onSubmit, isDisabled, isFocused }: InputBoxProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState("");

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isDisabled) return;

      // Add to history (deduplicate consecutive)
      setHistory((prev) => {
        const next = prev[0] === trimmed ? prev : [trimmed, ...prev];
        return next.slice(0, MAX_HISTORY);
      });

      setHistoryIndex(-1);
      setSavedInput("");
      setValue("");
      onSubmit(trimmed);
    },
    [onSubmit, isDisabled],
  );

  // Handle history navigation with up/down arrows
  useInput(
    (_input, key) => {
      if (!isFocused) return;

      if (key.upArrow && history.length > 0) {
        if (historyIndex === -1) {
          setSavedInput(value);
        }
        const nextIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(nextIndex);
        const historyItem = history[nextIndex];
        if (historyItem !== undefined) {
          setValue(historyItem);
        }
      }

      if (key.downArrow) {
        if (historyIndex > 0) {
          const nextIndex = historyIndex - 1;
          setHistoryIndex(nextIndex);
          const historyItem = history[nextIndex];
          if (historyItem !== undefined) {
            setValue(historyItem);
          }
        } else if (historyIndex === 0) {
          setHistoryIndex(-1);
          setValue(savedInput);
        }
      }
    },
    { isActive: isFocused },
  );

  return (
    <Box borderStyle="round" borderColor={isDisabled ? "gray" : isFocused ? "cyan" : "gray"} paddingLeft={1}>
      <Text color={isDisabled ? "gray" : "green"} bold>
        {">"}{" "}
      </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        focus={isFocused && !isDisabled}
        placeholder={isDisabled ? "waiting for response..." : "type a message..."}
        showCursor
      />
    </Box>
  );
}
