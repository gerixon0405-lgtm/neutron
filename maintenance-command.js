function isOptimizationRequest(text) {
  const command = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .trim().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  return /^(?:\/optimalizalas|(?:kerlek[,]? )?optimalizald (?:a )?(?:gepem(?:et)?|szamitogepem(?:et)?|windowst)(?: (?:a maximumra|maximalisan|teljesen))?)$/.test(command);
}
module.exports = {isOptimizationRequest};
