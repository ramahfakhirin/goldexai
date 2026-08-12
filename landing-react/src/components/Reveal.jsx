import { motion } from 'framer-motion';

// Shared entrance choreography: fade + rise, triggered once per element as
// it enters the viewport. `stagger` turns a wrapper into a stagger parent
// for motion children that use `revealItem` variants.
export const revealItem = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.16, 1, 0.3, 1] } },
};

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

export function Reveal({ children, delay = 0, y = 22, className, as: Tag = motion.div, ...rest }) {
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function RevealGroup({ children, className }) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-80px' }}
      variants={container}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({ children, className, ...rest }) {
  return (
    <motion.div className={className} variants={revealItem} {...rest}>
      {children}
    </motion.div>
  );
}
