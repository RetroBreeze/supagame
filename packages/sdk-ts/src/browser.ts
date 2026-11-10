import { createAchievementQueue } from "./achievement-notifications.js";
import type { Achievements } from "./achievements.js";
/** Optional DOM renderer. Text is assigned with textContent; icon identifiers are never HTML/URLs. */
export function mountAchievementNotifications(
  source: Pick<Achievements, "onUnlocked">,
  options: {
    container?: HTMLElement;
    className?: string;
    durationMs?: number;
    iconText?: (id: string | null) => string;
  } = {},
) {
  const element = document.createElement("aside");
  element.className = options.className ?? "supagame-achievement";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  const label = document.createElement("div"),
    title = document.createElement("strong"),
    description = document.createElement("p"),
    dismiss = document.createElement("button");
  label.textContent = "ACHIEVEMENT UNLOCKED";
  dismiss.textContent = "Dismiss";
  element.append(label, title, description, dismiss);
  (options.container ?? document.body).append(element);
  const queue = createAchievementQueue(source, options);
  const off = queue.subscribe((a) => {
    element.hidden = !a;
    if (a) {
      title.textContent = `${options.iconText?.(a.icon) ?? "★"} ${a.title}`;
      description.textContent = a.description;
    }
  });
  const click = () => queue.dismiss();
  dismiss.addEventListener("click", click);
  return {
    queue,
    element,
    dispose() {
      off();
      queue.dispose();
      dismiss.removeEventListener("click", click);
      element.remove();
    },
  };
}
