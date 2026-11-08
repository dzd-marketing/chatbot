import { motion } from "framer-motion";
import { WelcomeLoader } from "./welcome-loader";

export const Greeting = () => (
  <div className="relative flex flex-col items-center px-2" key="overview">
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      className="mb-8"
      initial={{ opacity: 0, scale: 0.9 }}
      transition={{ delay: 0.2, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      <WelcomeLoader />
    </motion.div>
    <motion.h1
      animate={{ opacity: 1, y: 0 }}
      className="text-balance text-center font-semibold text-3xl leading-tight tracking-tight text-foreground sm:text-4xl md:text-[2.75rem]"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      Hi, I&apos;m <span className="text-brand-ink">TheStudent AI</span>. What
      are we studying today?
    </motion.h1>
  </div>
);
