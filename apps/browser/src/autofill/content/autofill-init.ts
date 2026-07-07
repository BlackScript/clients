import { EVENTS } from "@bitwarden/common/autofill/constants";

import AutofillPageDetails from "../models/autofill-page-details";
import { AutofillInlineMenuContentService } from "../overlay/inline-menu/abstractions/autofill-inline-menu-content.service";
import { OverlayNotificationsContentService } from "../overlay/notifications/abstractions/overlay-notifications-content.service";
import { AutofillOverlayContentService } from "../services/abstractions/autofill-overlay-content.service";
import { DomElementVisibilityService } from "../services/abstractions/dom-element-visibility.service";
import { DomQueryService } from "../services/abstractions/dom-query.service";
import { SubmitLoginButtonNames } from "../services/autofill-constants";
import { CollectAutofillContentService } from "../services/collect-autofill-content.service";
import InsertAutofillContentService from "../services/insert-autofill-content.service";
import { AutofillTriageResponse } from "../types/autofill-triage";
import { sendExtensionMessage } from "../utils";
import { EventSecurity } from "../utils/event-security";

import {
  AutofillExtensionMessage,
  AutofillExtensionMessageHandlers,
  AutofillInit as AutofillInitInterface,
} from "./abstractions/autofill-init";

class AutofillInit implements AutofillInitInterface {
  private readonly sendExtensionMessage = sendExtensionMessage;
  private readonly collectAutofillContentService: CollectAutofillContentService;
  private readonly insertAutofillContentService: InsertAutofillContentService;
  private collectPageDetailsOnLoadTimeout: number | NodeJS.Timeout | undefined;
  private lastContextMenuClickedElement: HTMLElement | null = null;
  private isMonitoring = false;
  private lastFilledElement: HTMLElement | null = null;
  private autoSubmitFormOpids: string[] = [];
  private autoSubmitInProgress = false;
  private autoSubmitClickCount = 0;
  private static readonly MAX_AUTO_SUBMIT_CLICKS = 2; // Login + TOTP, dann Stop
  private pendingSubmitTimers: ReturnType<typeof setTimeout>[] = [];
  private readonly extensionMessageHandlers: AutofillExtensionMessageHandlers = {
    collectPageDetails: ({ message }) =>
      this.isMonitoring ? this.collectPageDetails(message) : undefined,
    collectPageDetailsImmediately: ({ message }) =>
      this.isMonitoring ? this.collectPageDetails(message, true) : undefined,
    collectAutofillTriage: () =>
      this.isMonitoring ? this.collectPageDetailsForContextMenu() : undefined,
    fillForm: ({ message }) => (this.isMonitoring ? this.fillForm(message) : undefined),
    applyTargetedFields: ({ message }) =>
      this.isMonitoring ? this.applyTargetedFields(message) : undefined,
    clearTargetingRulesCache: () => this.handleClearTargetingRulesCache(),
    startAutofillMonitors: () => this.startMonitoring(),
    stopAutofillMonitors: () => this.stopMonitoring(),
  };

  /**
   * AutofillInit constructor. Initializes the DomElementVisibilityService,
   * CollectAutofillContentService and InsertAutofillContentService classes.
   *
   * @param domQueryService - Service used to handle DOM queries.
   * @param domElementVisibilityService - Used to check if an element is viewable.
   * @param autofillOverlayContentService - The autofill overlay content service, potentially undefined.
   * @param autofillInlineMenuContentService - The inline menu content service, potentially undefined.
   * @param overlayNotificationsContentService - The overlay notifications content service, potentially undefined.
   */
  constructor(
    domQueryService: DomQueryService,
    domElementVisibilityService: DomElementVisibilityService,
    private autofillOverlayContentService?: AutofillOverlayContentService,
    private autofillInlineMenuContentService?: AutofillInlineMenuContentService,
    private overlayNotificationsContentService?: OverlayNotificationsContentService,
  ) {
    this.collectAutofillContentService = new CollectAutofillContentService(
      domElementVisibilityService,
      domQueryService,
      this.autofillOverlayContentService,
    );
    this.insertAutofillContentService = new InsertAutofillContentService(
      domElementVisibilityService,
      this.collectAutofillContentService,
    );
  }

  /**
   * Initializes the autofill content script, setting up
   * the extension message listeners. This method should
   * be called once when the content script is loaded.
   */
  init() {
    this.setupExtensionMessageListeners();
  }

  /**
   * Attaches monitoring-scoped listeners (contextmenu, LOAD) and fans
   * out to each sub-monitor. Idempotent.
   */
  startMonitoring(): void {
    if (this.isMonitoring) {
      return;
    }
    this.isMonitoring = true;

    // Start sub-monitors first so any page-details collection triggered
    // by this controller below sees a fully wired-up service graph.
    this.collectAutofillContentService.startMonitoring();
    this.autofillOverlayContentService?.startMonitoring();
    this.autofillInlineMenuContentService?.startMonitoring();
    this.collectPageDetailsOnLoad();
  }

  /**
   * Detaches monitoring-scoped listeners, cancels the LOAD timeout,
   * and fans out to each sub-monitor. Idempotent.
   */
  stopMonitoring(): void {
    this.isMonitoring = false;
    this.clearCollectPageDetailsOnLoadTimeout();
    globalThis.removeEventListener(EVENTS.LOAD, this.sendCollectDetailsMessage);
    this.collectAutofillContentService.stopMonitoring();
    this.autofillOverlayContentService?.stopMonitoring();
    this.autofillInlineMenuContentService?.stopMonitoring();
  }

  /**
   * Triggers a collection of the page details from the
   * background script, ensuring that autofill is ready
   * to act on the page.
   */
  private collectPageDetailsOnLoad() {
    if (globalThis.document.readyState === "complete") {
      this.sendCollectDetailsMessage();
    }

    globalThis.addEventListener(EVENTS.LOAD, this.sendCollectDetailsMessage);
  }

  /**
   * Sends a message to collect page details after a short delay.
   */
  private sendCollectDetailsMessage = () => {
    this.clearCollectPageDetailsOnLoadTimeout();
    this.collectPageDetailsOnLoadTimeout = setTimeout(
      () => this.sendExtensionMessage("bgCollectPageDetails", { sender: "autofillInit" }),
      750,
    );
  };

  /**
   * Collects the page details and sends them to the
   * extension background script. If the `sendDetailsInResponse`
   * parameter is set to true, the page details will be
   * returned to facilitate sending the details in the
   * response to the extension message.
   *
   * @param message - The extension message.
   * @param sendDetailsInResponse - Determines whether to send the details in the response.
   */
  private async collectPageDetails(
    message: AutofillExtensionMessage,
    sendDetailsInResponse = false,
  ): Promise<AutofillPageDetails | void> {
    const pageDetails: AutofillPageDetails =
      await this.collectAutofillContentService.getPageDetails();
    if (sendDetailsInResponse) {
      return pageDetails;
    }

    void this.sendExtensionMessage("collectPageDetailsResponse", {
      tab: message.tab,
      details: pageDetails,
      sender: message.sender,
    });
  }

  /**
   * Collects page details and returns them directly in the response for autofill triage.
   */
  private async collectPageDetailsForContextMenu(): Promise<AutofillTriageResponse> {
    const pageDetails = await this.collectAutofillContentService.getPageDetails();

    let targetFieldRef: string | undefined;
    const el = this.lastContextMenuClickedElement;
    if (el) {
      const htmlId = el.id;
      const htmlName = el instanceof HTMLInputElement ? el.name : undefined;
      const match = pageDetails.fields.find(
        (f) => (htmlId && f.htmlID === htmlId) || (htmlName && f.htmlName === htmlName),
      );
      targetFieldRef = match?.htmlID ?? match?.htmlName ?? undefined;
    }

    return { pageDetails, targetFieldRef };
  }

  /**
   * Fills the form with the given fill script.
   *
   * @param {AutofillExtensionMessage} message
   */
  private async fillForm({
    fillScript,
    pageDetailsUrl,
    autoSubmitAfterFill,
    showAnimations,
  }: AutofillExtensionMessage) {
    if ((document.defaultView || window).location.href !== pageDetailsUrl || !fillScript) {
      return;
    }

    this.blurFocusedFieldAndCloseInlineMenu();
    // Autoritative Form-opids aus dem Fill-Script (Upstream-Mechanismus, siehe
    // generateFillScript mit autoSubmitLogin) — Vorrang vor der DOM-Heuristik.
    this.autoSubmitFormOpids = fillScript.autosubmit ?? [];
    await this.sendExtensionMessage("updateIsFieldCurrentlyFilling", {
      isFieldCurrentlyFilling: true,
    });
    await this.insertAutofillContentService.fillForm(fillScript, showAnimations ?? true);

    // Gefülltes Element merken — activeElement ist nach dem Fill idealerweise das letzte Feld.
    // Falls activeElement body ist (z.B. nach Blur), Fallback über gefüllte Passwort-Felder.
    const activeEl = document.activeElement as HTMLElement;
    if (activeEl && activeEl !== document.body) {
      this.lastFilledElement = activeEl;
    } else {
      // Fallback: letztes sichtbares Passwort- oder Text-Input mit Wert finden
      const filledInputs = document.querySelectorAll<HTMLInputElement>(
        "input[type='password'], input[type='text'], input[type='email']",
      );
      const lastFilled = Array.from(filledInputs)
        .reverse()
        .find((el) => el.value && this.isElementVisible(el));
      this.lastFilledElement = lastFilled || activeEl;
    }

    setTimeout(
      () =>
        this.sendExtensionMessage("updateIsFieldCurrentlyFilling", {
          isFieldCurrentlyFilling: false,
        }),
      250,
    );

    // Nach dem Füllen automatisch absenden, wenn aktiviert
    if (
      autoSubmitAfterFill &&
      !this.autoSubmitInProgress &&
      this.autoSubmitClickCount < AutofillInit.MAX_AUTO_SUBMIT_CLICKS
    ) {
      this.autoSubmitInProgress = true;
      // Safety-Timeout: autoSubmitInProgress nach 10s zurücksetzen,
      // falls der Submit-Prozess hängenbleibt (Netzwerkfehler, unerwarteter Zustand)
      this.scheduleTimeout(() => {
        this.autoSubmitInProgress = false;
      }, 10000);
      this.scheduleTimeout(() => this.trySubmitForm(), 500);
    }
  }

  /**
   * Versucht das Formular abzusenden mit Retry-Mechanismus.
   * Manche Seiten brauchen Zeit bis der Submit-Button enabled wird
   * (z.B. Backend-Healthcheck, async Validierung). Wir prüfen alle 500ms
   * ob ein klickbarer Button vorhanden ist (max 3 Sekunden).
   */
  private trySubmitForm(attempt = 0) {
    const maxAttempts = 6; // 6 × 500ms = 3 Sekunden
    if (attempt > maxAttempts) {
      this.autoSubmitInProgress = false;
      return;
    }

    // Prüfen ob lastFilledElement noch im DOM ist
    if (this.lastFilledElement && !document.contains(this.lastFilledElement)) {
      this.lastFilledElement = null;
      this.autoSubmitInProgress = false;
      return;
    }

    // Framework-Model-Sync: Viele JS-Frameworks (ExtJS, React, Angular) speichern
    // Eingabewerte intern. Bitwarden setzt element.value direkt, aber das Framework-
    // Model bleibt leer. Drei Maßnahmen um die Synchronisation zu erzwingen:
    // 1. InputEvent mit korrekten Properties dispatchen (allgemein)
    // 2. Blur+Change Events (triggert ExtJS checkChange)
    // 3. Page-Context Script für ExtJS-spezifische API (setRawValue)
    if (attempt === 0) {
      // Phase 1: Framework-Sync — Reihenfolge ist kritisch für ExtJS (Proxmox)
      // 1. Erst ExtJS setRawValue() aufrufen (synchronisiert ExtJS-internes Model)
      this.forceFrameworkModelSync();
      // 2. Dann DOM-Events dispatchen (input → change → blur → focusout)
      //    ExtJS checkChange() wird durch blur getriggert (checkChangeBuffer: 50ms)
      this.dispatchFrameworkSyncEvents();
      // 3. Nochmals ExtJS-Sync nach den Events — fängt Fälle ab wo Events den Wert ändern
      this.scheduleTimeout(() => {
        this.forceFrameworkModelSync();
        // 4. Enter-Taste im gefüllten Feld simulieren — ExtJS/Proxmox reagiert auf
        //    Enter um Formulare abzusenden, bevor der Button überhaupt gesucht wird.
        this.simulateEnterKeyOnFilledField();
        // 400ms warten: ExtJS braucht checkChangeBuffer (50ms) + Event-Verarbeitung + Rerender
        this.scheduleTimeout(() => this.trySubmitFormClick(0), 400);
      }, 150);
      return;
    }

    this.trySubmitFormClick(attempt);
  }

  /**
   * Dispatcht Input/Change/Blur-Events auf alle sichtbaren gefüllten Felder
   * um Framework-interne Models (React, Vue, Angular, ExtJS) zu synchronisieren.
   *
   * Setzt zusätzlich den React _valueTracker zurück, damit React onChange auslöst.
   * Verwendet den nativen HTMLInputElement.prototype.value-Setter für Vue/Angular.
   */
  private dispatchFrameworkSyncEvents() {
    const nativeInputSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;

    const allInputs = document.querySelectorAll<HTMLInputElement>(
      "input:not([type='hidden']):not([type='checkbox']):not([type='radio'])",
    );
    for (const input of Array.from(allInputs)) {
      if (input.value && this.isElementVisible(input)) {
        // Nativen Setter aufrufen um Framework-Wrapper zu triggern
        if (nativeInputSetter) {
          nativeInputSetter.call(input, input.value);
        }
        // React Value-Tracker zurücksetzen
        const tracker = (input as any)?._valueTracker;
        if (tracker) {
          tracker.setValue("");
        }
        // Erst fokussieren — ExtJS bindet checkChange an den Focus/Blur-Zyklus
        input.focus();
        // Events in korrekter Reihenfolge: input → change → blur → focusout
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: false,
            inputType: "insertText",
            data: input.value,
          }),
        );
        input.dispatchEvent(new Event("change", { bubbles: true }));
        // blur UND focusout — blur bubbelt nicht nativ, focusout schon.
        // ExtJS nutzt blur direkt am Element, manche Frameworks hören auf focusout.
        input.dispatchEvent(new FocusEvent("blur", { bubbles: false, relatedTarget: null }));
        input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
      }
    }
  }

  /**
   * Sucht und klickt den Submit-Button. Separiert von trySubmitForm
   * um einen Delay nach Blur-Events zu ermöglichen.
   */
  private trySubmitFormClick(attempt: number) {
    const maxAttempts = 6;
    const clicked = this.findAndClickSubmitButton();
    if (clicked) {
      this.autoSubmitInProgress = false;
      this.clearPendingTimers();
      return;
    }
    if (attempt < maxAttempts) {
      this.scheduleTimeout(() => this.trySubmitForm(attempt + 1), 500);
    } else {
      this.autoSubmitInProgress = false;
    }
  }

  /**
   * Injiziert ein Script in den Page-Context (nicht Content-Script-Isolation),
   * das Framework-spezifische APIs aufruft um interne Datenmodelle mit den
   * aktuellen DOM-Werten zu synchronisieren.
   *
   * Aktuell unterstützt: ExtJS (Proxmox, Sencha-basierte Apps).
   * ExtJS-Textfelder speichern Werte intern als rawValue. Wenn der DOM-Wert
   * programmatisch gesetzt wird (element.value = x), bleibt rawValue leer.
   *
   * Das Script:
   * 1. Ruft setRawValue() auf (setzt den internen Rohwert)
   * 2. Ruft setValue() auf (triggert ExtJS-interne Validierung + checkChange)
   * 3. Markiert das Feld als dirty (damit ExtJS es beim Submit berücksichtigt)
   *
   * Fehlschlag (z.B. wegen CSP) wird still ignoriert — Blur-Events als Fallback.
   */
  private forceFrameworkModelSync() {
    try {
      const script = document.createElement("script");
      script.textContent = `(function(){
        try{
          if(typeof Ext!=='undefined'&&Ext.ComponentQuery){
            Ext.ComponentQuery.query('field').forEach(function(f){
              if(f.inputEl&&f.inputEl.dom){
                var v=f.inputEl.dom.value;
                if(!v)return;
                if(f.setRawValue&&f.getRawValue&&v!==f.getRawValue()){
                  f.setRawValue(v);
                }
                if(f.setValue&&f.getValue&&v!==f.getValue()){
                  f.suspendEvents&&f.suspendEvents();
                  f.setValue(v);
                  f.resumeEvents&&f.resumeEvents();
                }
                if(f.markDirty){f.markDirty()}
              }
            });
          }
        }catch(e){}
      })();`;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch {
      // CSP oder anderer Fehler — Blur-Events als Fallback
    }
  }

  /**
   * Sucht einen Submit-Button und klickt ihn.
   * Gibt true zurück wenn ein Button gefunden und geklickt wurde.
   *
   * Strategie-Reihenfolge:
   * 1. Enabled Submit-Button im Formular
   * 2. Klickbare Elemente mit Submit-Keywords (ExtJS, Custom UIs)
   * 3. cursor:pointer Elemente nahe dem gefüllten Feld
   */
  private findAndClickSubmitButton(): boolean {
    const filledEl = this.lastFilledElement;
    const form = this.getAutoSubmitFormByOpid() ?? (filledEl?.closest("form") as HTMLFormElement);

    // 1. Enabled Submit-Button im Formular (oder global)
    // Drei Fälle: explizit type="submit", button OHNE type (default=submit in HTML5),
    // oder input[type='submit']. CSS [type=submit] matcht NICHT den HTML-Default!
    const submitSelector =
      "button[type='submit']:not([disabled]), " +
      "button:not([type]):not([disabled]), " +
      "input[type='submit']:not([disabled])";
    let submitBtn =
      form?.querySelector<HTMLElement>(submitSelector) ||
      document.querySelector<HTMLElement>(submitSelector);

    // Buttons ohne type in Formularen sind Submit-Buttons (HTML5-Standard),
    // aber außerhalb von Formularen könnten sie beliebige Funktionen haben.
    // Daher: button:not([type]) außerhalb eines Formulars nur akzeptieren
    // wenn es auch Submit-Keywords enthält.
    if (submitBtn && !submitBtn.hasAttribute("type") && !submitBtn.closest("form")) {
      if (!this.isSubmitElement(submitBtn)) {
        submitBtn = null;
      }
    }

    if (submitBtn && this.isElementVisible(submitBtn)) {
      this.simulateFullClick(submitBtn);
      return true;
    }

    // 2. Klickbare Elemente mit Submit-Keywords (ExtJS Buttons, ARIA, Links)
    const clickableSelector =
      "button:not([disabled]), [role='button'], " +
      "a:not([href])[class*='btn'], a[href='#'][class*='btn'], a[href^='javascript:'][class*='btn']";
    const allClickables = document.querySelectorAll<HTMLElement>(clickableSelector);
    for (const el of Array.from(allClickables)) {
      if (el.tagName === "A" && this.isNavigationLink(el as HTMLAnchorElement)) {
        continue;
      }
      if (this.isSubmitElement(el) && this.isElementVisible(el)) {
        this.simulateFullClick(el);
        return true;
      }
    }

    // 3. cursor:pointer Elemente nahe dem gefüllten Feld — NUR mit Submit-Keywords
    if (filledEl && filledEl !== document.body && document.contains(filledEl)) {
      const pointerEl = this.findNearestSubmitPointerElement(filledEl);
      if (pointerEl) {
        this.simulateFullClick(pointerEl);
        return true;
      }
    }

    // 4. Letzter Fallback: form.requestSubmit() oder form.submit()
    // requestSubmit() ist bevorzugt — triggert submit-Event + HTML5-Validierung.
    if (form) {
      try {
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
        this.autoSubmitClickCount++;
        return true;
      } catch {
        // Submit fehlgeschlagen (z.B. Validierungsfehler) — kein Fehler
      }
    }

    return false;
  }

  /**
   * Löst das Ziel-Formular über die opids aus dem Fill-Script auf.
   * Die opid wird vom CollectAutofillContentService als Property an
   * jedes erfasste Formular-Element geschrieben.
   */
  private getAutoSubmitFormByOpid(): HTMLFormElement | null {
    if (!this.autoSubmitFormOpids.length) {
      return null;
    }
    const forms = document.querySelectorAll("form");
    for (const form of Array.from(forms)) {
      const opid = (form as HTMLFormElement & { opid?: string }).opid;
      if (opid && this.autoSubmitFormOpids.includes(opid)) {
        return form;
      }
    }
    return null;
  }

  /**
   * Simuliert einen vollständigen Mausklick (mousedown → mouseup → click).
   * Wichtig: element.click() statt dispatchEvent für den Click, damit die
   * Browser-Default-Action ausgelöst wird (z.B. Form-Submission bei Submit-Buttons).
   */
  private simulateFullClick(element: HTMLElement) {
    this.autoSubmitClickCount++;
    const eventInit: MouseEventInit = { bubbles: true, cancelable: true, view: window };
    element.dispatchEvent(new MouseEvent("mousedown", eventInit));
    element.dispatchEvent(new MouseEvent("mouseup", eventInit));
    element.click();
  }

  /**
   * Simuliert Enter-Taste im zuletzt gefüllten Feld.
   * ExtJS (Proxmox) und viele andere Frameworks behandeln Enter-Taste als
   * Form-Submit-Trigger. Das ist oft zuverlässiger als Button-Klick bei SPAs.
   */
  private simulateEnterKeyOnFilledField() {
    const filledEl = this.lastFilledElement;
    if (!filledEl || !document.contains(filledEl)) {
      return;
    }
    filledEl.focus();
    const enterInit: KeyboardEventInit = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    filledEl.dispatchEvent(new KeyboardEvent("keydown", enterInit));
    filledEl.dispatchEvent(new KeyboardEvent("keypress", enterInit));
    filledEl.dispatchEvent(new KeyboardEvent("keyup", enterInit));
  }

  /**
   * Prüft ob ein Element ein Submit-/Login-Button ist.
   * Kurze Keywords (≤ 2 Zeichen wie "ok") werden nur als ganzes Wort geprüft,
   * um Falschmeldungen zu vermeiden ("Dokumentation" enthält "ok" als Substring).
   */
  private isSubmitElement(element: HTMLElement): boolean {
    const normalizedText = this.getElementSearchText(element);

    // Längere Keywords: Substring-Match auf normalisiertem Text (z.B. "login" in "log-in")
    if (SubmitLoginButtonNames.some((kw) => kw.length > 2 && normalizedText.includes(kw))) {
      return true;
    }

    // Kurze Keywords (z.B. "ok"): Nur als ganzes Wort im sichtbaren Text/Attributen
    const shortKeywords = SubmitLoginButtonNames.filter((kw) => kw.length <= 2);
    if (shortKeywords.length === 0) {
      return false;
    }
    const rawWords = [
      element.textContent?.trim(),
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .split(/\s+/);
    return shortKeywords.some((kw) => rawWords.some((word) => word === kw));
  }

  /**
   * Prüft ob ein Element ein Cancel/Reset-Button ist.
   */
  private isResetOrCancelButton(element: HTMLElement): boolean {
    const searchText = this.getElementSearchText(element);
    const cancelKeywords = [
      "cancel",
      "reset",
      "abbrechen",
      "zurück",
      "back",
      "close",
      "schließen",
      "clear",
      "dismiss",
    ];
    return cancelKeywords.some((kw) => searchText.includes(kw));
  }

  /**
   * Sammelt durchsuchbaren Text eines Elements.
   * Nur semantische Attribute (sichtbarer Text, ARIA, etc.) — KEINE CSS-Klassen,
   * da diese nach Normalisierung Falschmeldungen erzeugen (z.B. "fa-book" → "fabook" enthält "ok").
   */
  private getElementSearchText(element: HTMLElement): string {
    return [
      element.textContent?.trim(),
      element.getAttribute("value"),
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("id"),
      element.getAttribute("name"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .replace(/[-_\s]+/g, "");
  }

  /**
   * Prüft ob ein <a>-Element ein Navigations-Link ist (hat echten href,
   * ist kein role="button"). Solche Links sollen nicht als Submit-Button geklickt werden.
   */
  private isNavigationLink(element: HTMLAnchorElement): boolean {
    if (element.getAttribute("role") === "button") {
      return false; // ExtJS-Pattern: <a role="button"> ohne href
    }
    const href = element.getAttribute("href");
    if (!href || href === "#" || href.startsWith("javascript:")) {
      return false; // Kein echter Navigations-Link
    }
    return true; // Echte Navigation → nicht als Submit-Button verwenden
  }

  /**
   * Findet das nächste klickbare Element (cursor:pointer) mit Submit-Keywords
   * in der Nähe des Referenz-Elements. Nur Elemente mit expliziten Submit-Keywords
   * werden berücksichtigt, um versehentliches Klicken von Sidebar-Buttons,
   * Navigations-Links etc. zu vermeiden.
   */
  private findNearestSubmitPointerElement(reference: HTMLElement): HTMLElement | null {
    const refRect = reference.getBoundingClientRect();
    let closest: HTMLElement | null = null;
    let minDistance = Infinity;

    // Gezielte Suche statt document.querySelectorAll("*") — deutlich performanter
    const candidateSelector =
      "button, input[type='submit'], input[type='button'], [role='button'], " +
      "a[class*='btn'], span[class*='btn'], div[class*='btn'], " +
      "a[class*='button'], span[class*='button'], div[class*='button']";
    const candidates = document.querySelectorAll<HTMLElement>(candidateSelector);
    for (const el of Array.from(candidates)) {
      if (el.contains(reference) || el === reference) {
        continue;
      }
      if (el.tagName === "A" && this.isNavigationLink(el as HTMLAnchorElement)) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || rect.width > 500) {
        continue;
      }
      if (!this.isElementVisible(el)) {
        continue;
      }
      if (this.isResetOrCancelButton(el)) {
        continue;
      }
      if (!this.isSubmitElement(el)) {
        continue;
      }

      const distance = Math.sqrt(
        Math.pow(rect.left - refRect.left, 2) + Math.pow(rect.top - refRect.top, 2),
      );
      if (distance < minDistance) {
        minDistance = distance;
        closest = el;
      }
    }
    return closest;
  }

  /**
   * Prüft ob ein Element sichtbar ist.
   */
  private isElementVisible(element: HTMLElement): boolean {
    if (!element) {
      return false;
    }
    return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  }

  /**
   * Plant einen Timer und merkt ihn für spätere Bereinigung.
   */
  private scheduleTimeout(callback: () => void, delay: number) {
    const timer = setTimeout(() => {
      this.pendingSubmitTimers = this.pendingSubmitTimers.filter((t) => t !== timer);
      callback();
    }, delay);
    this.pendingSubmitTimers.push(timer);
  }

  /**
   * Löscht alle ausstehenden Auto-Submit-Timer.
   */
  private clearPendingTimers() {
    for (const timer of this.pendingSubmitTimers) {
      clearTimeout(timer);
    }
    this.pendingSubmitTimers = [];
  }

  /**
   * Applies targeted fields dispatched from the background for this frame.
   * Called when the top-level frame has detected that a targeting rule crosses
   * into this iframe and has routed the inner selectors here.
   *
   * @param message - The extension message containing iframe targeted fields.
   */
  private applyTargetedFields(message: AutofillExtensionMessage): Promise<void> {
    return this.collectAutofillContentService.applyExternalTargetedFields(
      message.iframeTargetedFields ?? [],
    );
  }

  /**
   * Drops cached targeting rules in this frame and re-collects page details so
   * the background's `pageDetailsForTab` is repopulated with the new strategy.
   */
  private handleClearTargetingRulesCache(): void {
    this.collectAutofillContentService.clearCachedTargetingRules();
    void this.collectPageDetails({ command: "collectPageDetails", sender: "autofillInit" });
  }

  /**
   * Blurs the most recently focused field and removes the inline menu. Used
   * in cases where the background unlock or vault item reprompt popout
   * is opened.
   */
  private blurFocusedFieldAndCloseInlineMenu() {
    this.autofillOverlayContentService?.blurMostRecentlyFocusedField(true);
  }

  /**
   * Clears the send collect details message timeout.
   */
  private clearCollectPageDetailsOnLoadTimeout() {
    if (this.collectPageDetailsOnLoadTimeout) {
      clearTimeout(this.collectPageDetailsOnLoadTimeout);
    }
  }

  /**
   * Sets up the extension message listeners for the content script.
   */
  private setupExtensionMessageListeners() {
    chrome.runtime.onMessage.addListener(this.handleExtensionMessage);
    globalThis.document.addEventListener("contextmenu", this.handleContextMenuClick);
  }

  /**
   * Saves a local copy of the last element that was clicked to create the context menu.
   * @param event - The mouse click event.
   */
  private readonly handleContextMenuClick = (event: MouseEvent) => {
    if (EventSecurity.isEventTrusted(event)) {
      this.lastContextMenuClickedElement = event.target as HTMLElement;
    }
  };

  /**
   * Handles the extension messages sent to the content script.
   *
   * @param message - The extension message.
   * @param sender - The message sender.
   * @param sendResponse - The send response callback.
   */
  private handleExtensionMessage = (
    message: AutofillExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ): boolean | null => {
    const command: string = message.command;
    const handler: CallableFunction | undefined = this.getExtensionMessageHandler(command);
    if (!handler) {
      return null;
    }

    const messageResponse = handler({ message, sender });
    if (typeof messageResponse === "undefined") {
      return null;
    }

    void Promise.resolve(messageResponse).then((response) => sendResponse(response));
    return true;
  };

  /**
   * Gets the extension message handler for the given command.
   *
   * @param command - The extension message command.
   */
  private getExtensionMessageHandler(command: string): CallableFunction | undefined {
    if (this.autofillOverlayContentService?.messageHandlers?.[command]) {
      return this.autofillOverlayContentService.messageHandlers[command];
    }

    if (this.autofillInlineMenuContentService?.messageHandlers?.[command]) {
      return this.autofillInlineMenuContentService.messageHandlers[command];
    }

    if (this.overlayNotificationsContentService?.messageHandlers?.[command]) {
      return this.overlayNotificationsContentService.messageHandlers[command];
    }

    return this.extensionMessageHandlers[command];
  }

  /**
   * Handles destroying the autofill init content script. Removes all
   * listeners, timeouts, and object instances to prevent memory leaks.
   */
  destroy() {
    this.stopMonitoring();
    this.clearPendingTimers();
    this.autoSubmitInProgress = false;
    globalThis.document.removeEventListener("contextmenu", this.handleContextMenuClick);
    chrome.runtime.onMessage.removeListener(this.handleExtensionMessage);
    this.lastContextMenuClickedElement = null;
    this.autofillOverlayContentService?.destroy();
    this.autofillInlineMenuContentService?.destroy();
    this.overlayNotificationsContentService?.destroy();
  }
}

export default AutofillInit;
