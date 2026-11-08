"use client";

import {
  type ButtonHTMLAttributes,
  Children,
  isValidElement,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./icons";
import styles from "./select.module.css";

export type SelectChangeEvent = {
  target: { value: string; name: string };
  currentTarget: { value: string; name: string };
};

type OptionProps = {
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
};
type ParsedOption = { value: string; label: string; disabled: boolean };

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    return textOf((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function parseOptions(children: ReactNode): ParsedOption[] {
  const out: ParsedOption[] = [];
  const visit = (nodes: ReactNode) => {
    for (const child of Children.toArray(nodes)) {
      if (!isValidElement(child)) continue;
      const element = child as ReactElement<OptionProps>;
      if (element.type === "option") {
        const label = textOf(element.props.children);
        out.push({
          value:
            element.props.value === undefined
              ? label
              : String(element.props.value),
          label,
          disabled: Boolean(element.props.disabled),
        });
      } else if (element.props.children) {
        visit(element.props.children);
      }
    }
  };
  visit(children);
  return out;
}

export type SelectProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "value" | "defaultValue" | "children" | "type"
> & {
  children?: ReactNode;
  value?: string;
  defaultValue?: string;
  name?: string;
  required?: boolean;
  onChange?: (event: SelectChangeEvent) => void;
};

const MAX_LIST = 288;

function isPrintable(event: KeyboardEvent<HTMLButtonElement>) {
  return (
    event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
  );
}

export function Select({
  children,
  value,
  defaultValue,
  name = "",
  required,
  disabled,
  onChange,
  className = "",
  id,
  onKeyDown,
  onBlur,
  ...rest
}: SelectProps) {
  const options = useMemo(() => parseOptions(children), [children]);
  const autoId = useId();
  const triggerId = id ?? `select-${autoId}`;
  const listId = `${triggerId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", timer: 0 });

  const firstEnabled = options.find((option) => !option.disabled);
  const [inner, setInner] = useState<string>(
    defaultValue ?? firstEnabled?.value ?? options[0]?.value ?? "",
  );
  const controlled = value !== undefined;
  // An uncontrolled select whose chosen option has left `children` falls back
  // to the first enabled option, as a native select does.
  const innerValid = options.some((option) => option.value === inner);
  const current = controlled
    ? value
    : innerValid
      ? inner
      : (firstEnabled?.value ?? options[0]?.value ?? inner);
  const selectedIndex = options.findIndex((option) => option.value === current);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<{ up: boolean; max: number }>({
    up: false,
    max: MAX_LIST,
  });

  const enabledFrom = (start: number, step: 1 | -1) => {
    for (
      let index = start;
      index >= 0 && index < options.length;
      index += step
    ) {
      if (!options[index]?.disabled) return index;
    }
    return -1;
  };

  const openList = (target?: number) => {
    if (disabled) return;
    const fallback =
      selectedIndex >= 0 && !options[selectedIndex]?.disabled
        ? selectedIndex
        : enabledFrom(0, 1);
    setActive(target ?? fallback);
    setOpen(true);
  };
  const closeList = (refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (!controlled) setInner(option.value);
    if (option.value !== current) {
      onChange?.({
        target: { value: option.value, name },
        currentTarget: { value: option.value, name },
      });
    }
    closeList(true);
  };

  // Flip above when there is no room below; cap height to the room available.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !listRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const wanted = Math.min(listRef.current.scrollHeight + 2, MAX_LIST);
    const up = below < wanted && above > below;
    setPlacement({
      up,
      max: Math.max(120, Math.min(MAX_LIST, up ? above : below)),
    });
  }, [open]);

  // Keep the active option visible without scrolling the page.
  useEffect(() => {
    if (!open || active < 0 || !listRef.current) return;
    const list = listRef.current;
    const node = list.children[active] as HTMLElement | undefined;
    if (!node) return;
    if (node.offsetTop < list.scrollTop) {
      list.scrollTop = node.offsetTop;
    } else if (
      node.offsetTop + node.offsetHeight >
      list.scrollTop + list.clientHeight
    ) {
      list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight;
    }
  }, [open, active]);

  // Close on outside pointer press.
  useEffect(() => {
    if (!open) return;
    const handler = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [open]);

  useEffect(() => {
    const state = typeahead.current;
    return () => window.clearTimeout(state.timer);
  }, []);

  const runTypeahead = (key: string) => {
    window.clearTimeout(typeahead.current.timer);
    typeahead.current.text += key.toLowerCase();
    typeahead.current.timer = window.setTimeout(() => {
      typeahead.current.text = "";
    }, 600);
    const text = typeahead.current.text;
    const repeated = text.split("").every((char) => char === text[0]);
    const base = open ? active : selectedIndex;
    const start = Math.max(base + (repeated ? 1 : 0), 0);
    const needle = repeated ? (text[0] ?? "") : text;
    const indexes = options.map((_, index) => index);
    const order = [...indexes.slice(start), ...indexes.slice(0, start)];
    const hit = order.find(
      (index) =>
        !options[index]?.disabled &&
        options[index]?.label.toLowerCase().startsWith(needle),
    );
    if (hit === undefined) return;
    if (open) setActive(hit);
    else openList(hit);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled) return;
    const { key } = event;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) {
        event.preventDefault();
        openList();
      } else if (key === "Home" || key === "End") {
        event.preventDefault();
        openList(
          key === "Home"
            ? enabledFrom(0, 1)
            : enabledFrom(options.length - 1, -1),
        );
      } else if (isPrintable(event)) {
        event.preventDefault();
        runTypeahead(key);
      }
      return;
    }
    if (key === "ArrowDown") {
      event.preventDefault();
      const next = enabledFrom(active + 1, 1);
      if (next >= 0) setActive(next);
    } else if (key === "ArrowUp") {
      event.preventDefault();
      if (event.altKey) return closeList();
      const prev = enabledFrom(active - 1, -1);
      if (prev >= 0) setActive(prev);
    } else if (key === "Home") {
      event.preventDefault();
      setActive(enabledFrom(0, 1));
    } else if (key === "End") {
      event.preventDefault();
      setActive(enabledFrom(options.length - 1, -1));
    } else if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      const down = key === "PageDown";
      const target = Math.min(
        options.length - 1,
        Math.max(0, active + (down ? 10 : -10)),
      );
      const found = enabledFrom(target, down ? -1 : 1);
      if (found >= 0) setActive(found);
    } else if (key === "Enter" || (key === " " && !typeahead.current.text)) {
      event.preventDefault();
      commit(active);
    } else if (key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeList(true);
    } else if (key === "Tab") {
      setOpen(false);
    } else if (isPrintable(event)) {
      event.preventDefault();
      runTypeahead(key);
    }
  };

  const showPlaceholder = !selected || selected.value === "";
  return (
    <div
      ref={rootRef}
      className={`${styles.select} ${className}`}
      data-open={open ? "true" : undefined}
    >
      <button
        {...rest}
        ref={triggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && active >= 0 ? `${listId}-${active}` : undefined
        }
        aria-required={required || undefined}
        data-value={current}
        disabled={disabled}
        className={`${styles.trigger} ${showPlaceholder ? styles.placeholder : ""}`}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          onBlur?.(event);
          if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
            setOpen(false);
          }
        }}
      >
        <span className={styles.value}>{selected?.label ?? ""}</span>
        <span className={styles.chevron} aria-hidden="true">
          <Icon name="chevronDown" size={16} />
        </span>
      </button>
      {name && (
        <input type="hidden" name={name} value={current} disabled={disabled} />
      )}
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          className={`${styles.list} ${placement.up ? styles.up : ""}`}
          style={{ maxHeight: placement.max }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            // biome-ignore lint/a11y/useFocusableInteractive: options are driven by aria-activedescendant on the trigger (APG select-only combobox)
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard is handled on the combobox trigger
            <div
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              data-value={option.value}
              aria-selected={index === selectedIndex}
              aria-disabled={option.disabled || undefined}
              data-active={index === active ? "true" : undefined}
              className={styles.option}
              onMouseMove={() => {
                if (!option.disabled && active !== index) setActive(index);
              }}
              onClick={() => commit(index)}
            >
              <span className={styles.optionLabel}>{option.label}</span>
              <span className={styles.check} aria-hidden="true">
                {index === selectedIndex && <Icon name="check" size={16} />}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
