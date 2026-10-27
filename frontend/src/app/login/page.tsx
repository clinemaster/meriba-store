"use client";

import { useEffect, useRef, useState } from "react";

import { errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import styles from "./login.module.css";

const SLIDES = [
  { src: "/login/slide1.jpg", alt: "Meriba Liquor Store", caption: "Meriba Liquor Store" },
  { src: "/login/slide2.jpg", alt: "Meriba Liquor Store", caption: "Meriba Liquor Store" },
  { src: "/login/slide4.jpg", alt: "Meriba Liquor Store", caption: "Meriba Liquor Store" },
  { src: "/login/slide6.jpg", alt: "Meriba Liquor Store", caption: "Meriba Liquor Store" },
  { src: "/login/slide8.jpg", alt: "Meriba Liquor Store", caption: "Meriba Liquor Store" },
  { src: "/login/slide9.jpg", alt: "Meriba Liquor Store", caption: "Meriba Liquor Store" },
  { src: "/login/slide10.jpg", alt: "Meriba Liquor Store", caption: "Meriba Liquor Store" },
] as const;

function ArrowIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={styles.icon}>
      {direction === "left" ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
    </svg>
  );
}

export default function LoginPage() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const submitLock = useRef(false);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setSlideIndex((index) => (index + 1) % SLIDES.length), 6000);
    return () => window.clearInterval(timer);
  }, [slideIndex]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    if (!username.trim() || !password) {
      setError("Enter your username and your password.");
      return;
    }

    submitLock.current = true;
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
      submitLock.current = false;
    }
  }

  function moveSlide(direction: -1 | 1) {
    setSlideIndex((index) => (index + direction + SLIDES.length) % SLIDES.length);
  }

  const slide = SLIDES[slideIndex];

  return (
    <main className={styles.page}>
      <div className={styles.background} aria-hidden="true" />
      <section className={styles.card} aria-label="Meriba Liquor Store sign in">
        <div className={styles.slideshow} aria-label="Store image slideshow">
          <img key={slide.src} className={styles.slideImage} src={slide.src} alt={slide.alt} />
          <div className={styles.slideShade} />
          <div className={styles.caption}>
            <span>{slide.caption}</span>
          </div>
          <button type="button" className={`${styles.slideArrow} ${styles.previous}`} aria-label="Previous image" onClick={() => moveSlide(-1)}>
            <ArrowIcon direction="left" />
          </button>
          <button type="button" className={`${styles.slideArrow} ${styles.next}`} aria-label="Next image" onClick={() => moveSlide(1)}>
            <ArrowIcon direction="right" />
          </button>
          <div className={styles.dots} aria-label="Choose an image">
            {SLIDES.map((item, index) => (
              <button
                key={item.src}
                type="button"
                className={`${styles.dot} ${index === slideIndex ? styles.selectedDot : ""}`}
                aria-label={`Show image ${index + 1}: ${item.caption}`}
                aria-current={index === slideIndex ? "true" : undefined}
                onClick={() => setSlideIndex(index)}
              />
            ))}
          </div>
        </div>

        <div className={styles.formPanel}>
          <div className={styles.brandBlock}>
            <h1>Meriba Liquor Store</h1>
          </div>

          <form className={styles.form} onSubmit={submit} noValidate aria-busy={busy}>
            <div className={styles.inputWrap}>
              <label className={styles.visuallyHidden} htmlFor="login-username">Username</label>
              <input
                id="login-username"
                autoComplete="username"
                name="username"
                placeholder="Username *"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                disabled={busy}
                required
              />
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={styles.fieldIcon}>
                <rect x="3.5" y="5" width="17" height="14" rx="2" />
                <path d="m4.5 7 7.5 6 7.5-6" />
              </svg>
            </div>

            <div className={styles.inputWrap}>
              <label className={styles.visuallyHidden} htmlFor="login-password">Password</label>
              <input
                id="login-password"
                autoComplete="current-password"
                name="password"
                placeholder="Password *"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={busy}
                required
              />
              <button
                type="button"
                className={styles.passwordToggle}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((shown) => !shown)}
                disabled={busy}
              >
                {showPassword ? (
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={styles.fieldIcon}>
                    <path d="M3 3 21 21M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.2A10.8 10.8 0 0 1 12 5c5.3 0 8.7 4.5 9.5 6-.3.6-1.3 2-3 3.4M6.2 6.3C4.1 7.6 2.8 9.5 2.5 11c.8 1.5 4.2 6 9.5 6 1 0 1.9-.2 2.7-.5" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={styles.fieldIcon}>
                    <path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                )}
              </button>
            </div>

            {error && <p className={styles.error} role="alert">{error}</p>}

            <button type="submit" className={styles.loginButton} disabled={busy}>
              {busy && <span className={styles.spinner} aria-hidden="true" />}
              {busy ? "Signing in…" : "LOGIN"}
            </button>
            <p className={styles.passwordHelp}>Forgot your password? Ask the Owner to give you a new one.</p>
          </form>
        </div>
      </section>
      <p className={styles.assetNotice}>Brand mark and background shown here are placeholders.</p>
    </main>
  );
}
