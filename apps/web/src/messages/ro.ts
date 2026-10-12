/**
 * Fișierul de traduceri (română). Toate textele vizibile ale paginilor de autentificare stau aici,
 * nu în componente: traducerea în altă limbă (ex. engleză, la cerere) înseamnă un fișier nou cu
 * aceeași formă. Funcțiile primesc valorile dinamice (minute, lungimi), ca acordul să fie corect.
 */
export const ro = {
  auth: {
    common: {
      email: "Email",
      password: "Parolă",
      name: "Nume",
      showPassword: "Arată parola",
      hidePassword: "Ascunde parola",
      submitting: "Se trimite…",
      backToLogin: "Înapoi la autentificare",
      errorTitle: "Nu am putut continua",
      required: "Câmpul este obligatoriu.",
      invalidEmail: "Introdu o adresă de email validă.",
      passwordMin: (min: number) => `Parola trebuie să aibă cel puțin ${min} de caractere.`,
      passwordMax: (max: number) => `Parola poate avea cel mult ${max} de caractere.`,
      genericError: "A apărut o eroare. Încearcă din nou.",
      networkError: "Nu ne-am putut conecta. Verifică conexiunea și încearcă din nou.",
      rateLimited: (retryAfterSeconds: number | null) => {
        if (retryAfterSeconds === null || retryAfterSeconds <= 0) {
          return "Prea multe încercări. Încearcă din nou mai târziu.";
        }
        const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
        return `Prea multe încercări. Poți încerca din nou peste ${minutes} ${
          minutes === 1 ? "minut" : "minute"
        }.`;
      },
    },
    login: {
      metaTitle: "Autentificare",
      title: "Autentificare",
      description: "Intră în contul tău.",
      submit: "Intră în cont",
      forgot: "Ai uitat parola?",
      noAccount: "Nu ai cont?",
      register: "Creează un cont",
      // Același mesaj pentru email inexistent, parolă greșită și cont blocat (fără enumerare).
      invalidCredentials: "Email sau parolă incorecte.",
      emailNotVerified:
        "Emailul nu este verificat. Deschide linkul din mesajul de confirmare sau cere unul nou.",
      resend: "Trimite din nou emailul de verificare",
      resent: "Dacă adresa există și nu e verificată, am trimis un nou mesaj de confirmare.",
    },
    register: {
      metaTitle: "Creare cont",
      title: "Creează un cont",
      description: "Câteva date și ești gata.",
      submit: "Creează contul",
      haveAccount: "Ai deja cont?",
      login: "Autentifică-te",
      emailTaken: "Există deja un cont cu această adresă de email.",
      passwordHint: (min: number) => `Minim ${min} de caractere.`,
      checkEmailTitle: "Verifică-ți emailul",
      checkEmail:
        "Ți-am trimis un mesaj de confirmare. Deschide linkul din el ca să-ți activezi contul.",
    },
    forgot: {
      metaTitle: "Recuperare parolă",
      title: "Ai uitat parola?",
      description: "Introdu emailul și îți trimitem instrucțiunile de resetare.",
      submit: "Trimite instrucțiunile",
      // Același mesaj indiferent dacă există sau nu un cont cu acest email.
      sent: "Dacă există un cont cu această adresă de email, am trimis instrucțiunile de resetare.",
    },
    reset: {
      metaTitle: "Resetare parolă",
      title: "Alege o parolă nouă",
      description: "După schimbare, vei fi deconectat de pe toate dispozitivele.",
      newPassword: "Parolă nouă",
      submit: "Schimbă parola",
      invalidToken:
        "Linkul de resetare a expirat sau nu este valid. Cere un link nou de la pagina de recuperare.",
      requestNew: "Cere un link nou",
      done: "Parola a fost schimbată. Te poți autentifica cu parola nouă.",
      missingToken: "Linkul de resetare este incomplet. Cere un link nou.",
    },
    verify: {
      metaTitle: "Verificare email",
      successTitle: "Email verificat",
      success: "Adresa ta de email a fost confirmată. Te poți autentifica.",
      errorTitle: "Link invalid sau expirat",
      error: "Linkul de verificare nu este valid sau a expirat. Cere un mesaj nou.",
      resendDescription: "Introdu emailul și îți trimitem un nou mesaj de confirmare.",
      resend: "Trimite mesajul de verificare",
      sent: "Dacă adresa există și nu e verificată, am trimis un nou mesaj de confirmare.",
    },
    account: {
      metaTitle: "Contul meu",
      title: (name: string) => `Bună, ${name}`,
      description: "Ești autentificat.",
      email: "Email",
      signOut: "Deconectare",
      signingOut: "Se deconectează…",
    },
  },
  admin: {
    metaTitle: "Administrare",
    skipToContent: "Sari la conținut",
    sidebarLabel: "Navigare principală",
    openMenu: "Deschide meniul",
    closeMenu: "Închide meniul",
    breadcrumbLabel: "Poziția în pagină",
    home: "Panou",
    dashboard: {
      title: "Panou de control",
      description: "Prezentare generală a magazinului.",
      placeholder:
        "Aici vor apărea indicatorii magazinului, pe măsură ce sunt construite secțiunile.",
    },
    nav: {
      dashboard: "Panou",
      orders: "Comenzi",
      products: "Produse",
      inventory: "Stoc",
      customers: "Clienți",
      discounts: "Reduceri",
      reviews: "Recenzii",
      blog: "Blog",
      loyalty: "Loialitate",
      vouchers: "Vouchere",
      content: "Conținut",
      reports: "Rapoarte",
      settings: "Setări",
      users: "Utilizatori și roluri",
      audit: "Jurnal de audit",
    },
    userMenu: {
      button: "Meniul utilizatorului",
      account: "Contul meu",
      theme: "Aspect",
      signOut: "Deconectare",
      signingOut: "Se deconectează…",
    },
    theme: {
      system: "Sistem",
      light: "Luminos",
      dark: "Întunecat",
    },
    session: {
      expired: "Sesiunea a expirat. Autentifică-te din nou.",
    },
    forbidden: {
      title: "Acces interzis",
      noAdminAccess: "Contul tău nu are acces la zona de administrare.",
      noPermission: "Nu ai permisiunea necesară pentru această secțiune.",
      backHome: "Înapoi la panou",
      toAccount: "Spre contul meu",
    },
    comingSoon: {
      title: "Secțiune în construire",
      description: "Această secțiune va fi disponibilă într-o etapă următoare.",
    },
  },
} as const;

export type Messages = typeof ro;
