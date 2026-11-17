export { cn, TEXT_SIZE_TOKENS } from "./lib/cn";
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { Input, type InputProps } from "./components/input";
export { Label } from "./components/label";
export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/card";
export { PasswordInput, type PasswordInputProps } from "./components/password-input";
export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export { Counter } from "./components/counter";
export { Progress, type ProgressProps } from "./components/progress";
export { Select, type SelectProps } from "./components/select";
export { Textarea, type TextareaProps } from "./components/textarea";
export { Dialog, type DialogProps } from "./components/dialog";
export { Tabs, type TabItem, type TabsProps } from "./components/tabs";
export { TabsFade, scrollEdges, type ScrollMetrics } from "./components/tabs-fade";
export { SaveBar, type SaveBarProps } from "./components/save-bar";
export { Section, type SectionProps } from "./components/form-section";
export { filterChipClass } from "./components/filter-chip";
export { TAB_LIST_CLASS, tabClass } from "./components/tab-styles";
export {
  Pagination,
  pageWindow,
  type PaginationLinkProps,
  type PaginationProps,
} from "./components/pagination";
export {
  KpiCard,
  KpiContent,
  kpiCardVariants,
  type KpiCardProps,
  type KpiContentProps,
} from "./components/kpi-card";
export { FileInput, type FileInputProps } from "./components/file-input";
export { describeFiles, formatFileSize } from "./lib/file-size";
export {
  RowHeader,
  Table,
  TableCaption,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  tablePriorityClass,
  tableStackClass,
  type TablePriority,
  type TableStack,
} from "./components/table";
export { Drawer, DrawerSection, type DrawerProps } from "./components/drawer";
export { Skeleton } from "./components/skeleton";
export { EmptyState, type EmptyStateProps } from "./components/empty-state";
export {
  SegmentedBar,
  segmentShares,
  type Segment,
  type SegmentedBarProps,
  type SegmentTone,
} from "./components/segmented-bar";
export { ToastProvider, useToast } from "./components/toast";
export {
  TOAST_DURATION_MS,
  TOAST_LIMIT,
  addToast,
  autoDismisses,
  removeToast,
  type ToastInput,
  type ToastItem,
  type ToastTone,
} from "./components/toast-state";

// Vitrina (Faza 6): componente de bază, doar tokeni semantici (docs/21 §2).
export { Container, type ContainerProps } from "./storefront/container";
export { StoreButton, storeButtonVariants, type StoreButtonProps } from "./storefront/store-button";
export { StoreCard, ProductCard, type ProductCardProps } from "./storefront/store-card";
export { StorePill, type StorePillTone } from "./storefront/store-pill";
export { StoreImage, type StoreImageProps } from "./storefront/store-image";
export { HeroBanner, type HeroBannerProps } from "./storefront/hero-banner";
export { HeroSplit, type HeroSplitProps } from "./storefront/hero-split";
export { TrustBar, type TrustItem } from "./storefront/trust-bar";
export { EnergyLabel, ENERGY_SCALE, type EnergyLabelProps } from "./storefront/energy-label";
export { StoreSearch, STORE_SEARCH_FIELD, type StoreSearchProps } from "./storefront/store-search";
export { SectionHeading } from "./storefront/section-heading";
export { AnnouncementBar, type AnnouncementBarProps } from "./storefront/announcement-bar";
export { StorefrontState, type StorefrontStateProps } from "./storefront/storefront-state";
export { StoreSkeleton, StorefrontLoading } from "./storefront/store-skeleton";
export { NavSheet, type NavSheetProps } from "./storefront/nav-sheet";
